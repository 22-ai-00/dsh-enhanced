import { Context } from '@deepseek-ai/cordis'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrokerClientError,
  BrokerPostDispatchUnknownError,
  requestActionBroker,
} from '../src/broker-client.ts'
import { runBrokerCli } from '../src/broker-cli.ts'
import { ExternalBrokerCore } from '../src/broker-core.ts'
import { brokerPayloadBytes, withActionGrantDigest, type ExternalActionGrantUnsigned } from '../src/broker-ledger.ts'
import {
  ACTION_BROKER_PROTOCOL,
  ACTION_GRANT_PROTOCOL,
  BrokerProtocolError,
  createActionBrokerClientRequest,
  createActionBrokerServerHello,
  createActionGrantProjection,
  type ActionBrokerClientRequest,
  type ActionBrokerRequestIntent,
  type ActionBrokerServerResponse,
} from '../src/broker-protocol.ts'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { startGitHubBrokerServer, type BrokerPeerCredentialInspector, type GitHubBrokerServer } from '../src/broker-server.ts'
import { AssistantActionsService } from '../src/service.ts'

const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0
const keys = generateKeyPairSync('ed25519')
const serverKeys = generateKeyPairSync('ed25519')
const clientKeys = generateKeyPairSync('ed25519')
const adminKeys = generateKeyPairSync('ed25519')
const roots: string[] = []
const servers: GitHubBrokerServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(dir)
  await chmod(dir, 0o700)
  return dir
}

describe('ExternalBrokerCore v2 + Service Generalized Tools', () => {
  it.skipIf(process.platform !== 'linux')('executes http, lark, calendar, and shell domains over v2 wire protocol with WP08 enforcement', async () => {
    const now = Date.now()
    const root = await makeTempDir('broker-v2-e2e-')
    const credDir = join(root, 'creds')
    const sockDir = join(root, 'sock')
    const adminDir = join(root, 'admin')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(credDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(adminDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const tokenPath = join(credDir, 'api.token')
    await writeFile(tokenPath, 'v2_secret_token_abc', { mode: 0o600 })
    await chmod(tokenPath, 0o600)

    const httpServer = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer v2_secret_token_abc') {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    try {
      const owner = {
        principalDigest: 'a'.repeat(64),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: workDir,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const baseFields = {
        protocol: ACTION_GRANT_PROTOCOL,
        revision: 1,
        clientKeyId: 'client-v2',
        owner,
        sessionId: 'session-v2',
        expiresAt: now + 60_000,
        maxActions: 10,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 10,
        client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
        source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
      }

      const httpGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-http',
        domain: 'http',
        credentialId: 'api-cred',
        destination: {
          classification: 'http-endpoint',
          allowedSchemes: ['http'],
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [port],
          allowedMethods: ['GET'],
          allowedPathPrefixes: ['/v1/'],
          allowRedirects: false,
          allowPrivateNetwork: true,
          maxResponseBytes: 8_192,
          authHeader: 'authorization',
          authScheme: 'Bearer',
        },
        allowedOperations: ['http.request'],
        lease: { leaseId: 'lease-http', expiresAtMs: now + 60_000, maxUses: 1 },
        monetaryCostCapMicros: 1_000,
      } satisfies ExternalActionGrantUnsigned)

      const shellGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-shell',
        domain: 'shell',
        credentialId: 'no-secret',
        destination: {
          classification: 'shell-command',
          allowedCwds: [workDir],
          allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
          allowedEnvKeys: [],
          maxTimeoutMs: 5_000,
          maxStdoutBytes: 4_096,
          maxStderrBytes: 4_096,
          allowNetwork: false,
        },
        allowedOperations: ['shell.exec'],
      } satisfies ExternalActionGrantUnsigned)

      const core = new ExternalBrokerCore({
        instanceId: 'broker-v2',
        statePath: join(root, 'broker.sqlite'),
        credentials: [
          { id: 'api-cred', provider: 'linux-protected-file', path: tokenPath, maxLeaseMs: 30_000 },
          { id: 'no-secret', provider: 'injected-lease', maxLeaseMs: 30_000 },
        ],
        grants: [],
        actionGrants: [httpGrant, shellGrant],
        policyEpoch: 1,
      })

      const peer: BrokerPeerCredentialInspector = () => ({ uid, gid, pid: process.pid })
      const server = await startGitHubBrokerServer({
        actionSocketPath: join(sockDir, 'action.sock'),
        adminSocketPath: join(adminDir, 'admin.sock'),
        instanceId: 'broker-v2',
        generation: core.snapshot().generation,
        serverPrivateKey: serverKeys.privateKey,
        clientPublicKey: clientKeys.publicKey,
        clientKeyId: 'client-v2',
        adminPublicKey: adminKeys.publicKey,
        adminKeyId: 'admin-v2',
        core,
        inspectPeerCredentials: peer,
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
        protocolMode: 'action-v2',
      })
      servers.push(server)

      const clientOptions = {
        socketPath: server.actionSocketPath,
        serverPublicKey: serverKeys.publicKey,
        clientPrivateKey: clientKeys.privateKey,
        clientKeyId: 'client-v2',
        source: baseFields.client,
        expectedSocketUid: uid,
        expectedSocketGid: gid,
        expectedSocketMode: 0o600,
        expectedSocketParentUid: uid,
        expectedSocketParentGid: gid,
        expectedSocketParentMode: 0o700,
        inspectPeerCredentials: peer,
        expectedBrokerPeerUid: uid,
        expectedBrokerPeerGid: gid,
        expectedServerInstanceId: 'broker-v2',
        minimumServerGeneration: 1,
      }

      const httpPayload = { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/ping` }
      const httpIntent: ActionBrokerRequestIntent = {
        actionId: 'v2-http-1',
        grantId: httpGrant.id,
        grantRevision: 1,
        grantDigest: httpGrant.digest,
        domain: 'http',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-1',
        callId: 'call-1',
        operation: 'http.request',
        source: baseFields.source,
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ping' },
        payload: httpPayload,
        deadline: now + 20_000,
        budget: {
          reservationId: 'res-http-1',
          actions: 1,
          bytes: Buffer.byteLength(JSON.stringify(httpPayload)),
          costMetric: 'http-requests',
          maxCostUnits: 1,
          estimatedCostMicros: 250,
        },
        estimatedCostMicros: 250,
        idempotencyKey: 'idem-http-1',
      }
      // Compute exact canonical bytes
      const dummyHello = createActionBrokerServerHello({ instanceId: 'broker-v2', generation: 1, policyEpoch: 1, emergencyEpoch: 0, expiresAt: now + 20_000 }, serverKeys.privateKey)
      const tempReq = createActionBrokerClientRequest(httpIntent, dummyHello, baseFields.client, 'client-v2', clientKeys.privateKey)
      const httpRes = await requestActionBroker(clientOptions, { ...httpIntent, budget: { ...httpIntent.budget, bytes: brokerPayloadBytes(tempReq) } })
      expect(httpRes.status).toBe('succeeded')
      expect(httpRes.result).toMatchObject({ domain: 'http', operation: 'http.request', statusCode: 200 })

      // Second HTTP request hits lease.maxUses = 1
      const httpIntent2 = {
        ...httpIntent,
        actionId: 'v2-http-2',
        callId: 'call-2',
        budget: { ...httpIntent.budget, reservationId: 'res-http-2', bytes: brokerPayloadBytes(tempReq) },
        idempotencyKey: 'idem-http-2',
      }
      const httpRes2 = await requestActionBroker(clientOptions, httpIntent2)
      expect(httpRes2.status).toBe('failed')
      expect(httpRes2.error?.code).toBe('grant-invalid')

      // Shell execution via v2 broker
      const shellPayload = { executable: process.execPath, args: ['-e', 'process.stdout.write("v2-shell-ok")'], cwd: workDir, timeoutMs: 3_000 }
      const shellIntent: ActionBrokerRequestIntent = {
        actionId: 'v2-shell-1',
        grantId: shellGrant.id,
        grantRevision: 1,
        grantDigest: shellGrant.digest,
        domain: 'shell',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-2',
        callId: 'call-shell-1',
        operation: 'shell.exec',
        source: baseFields.source,
        destination: { classification: 'shell-command', executable: process.execPath, cwd: workDir },
        payload: shellPayload,
        deadline: now + 20_000,
        budget: { reservationId: 'res-shell-1', actions: 1, bytes: 0, costMetric: 'shell-exec-units', maxCostUnits: 1 },
      }
      const tempShellReq = createActionBrokerClientRequest(shellIntent, dummyHello, baseFields.client, 'client-v2', clientKeys.privateKey)
      const shellRes = await requestActionBroker(clientOptions, { ...shellIntent, budget: { ...shellIntent.budget, bytes: brokerPayloadBytes(tempShellReq) } })
      expect(shellRes.status).toBe('succeeded')
      expect(shellRes.result).toMatchObject({ domain: 'shell', operation: 'shell.exec', exitCode: 0, stdout: 'v2-shell-ok' })
    } finally {
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('registers generalized tools via runtime.tools.register without calling registerPreauthorizedTool', async () => {
    const root = await makeTempDir('service-v2-tools-')
    const stateRoot = join(root, 'state')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })
    const now = Date.now()

    const shellGrantUnsigned: ExternalActionGrantUnsigned = {
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'shell-local-1',
      revision: 1,
      domain: 'shell',
      clientKeyId: 'host-1',
      owner: {
        principalDigest: 'a'.repeat(64),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: workDir,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      },
      sessionId: 'sess-1',
      destination: {
        classification: 'shell-command',
        allowedCwds: [workDir],
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 2_048,
        maxStderrBytes: 2_048,
        allowNetwork: false as const,
      },
      credentialId: 'none',
      expiresAt: now + 60_000,
      maxActions: 5,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 5,
      allowedOperations: ['shell.exec'],
      client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
    }
    const projection = createActionGrantProjection(shellGrantUnsigned)

    const registeredTools: string[] = []
    const preauthorizedTools: string[] = []
    const fakeAgent = { id: 'agent-1', session: { id: 'sess-1', header: { cwd: workDir, agentPreset: 'primary' } } }

    const ctx = new Context()
    ctx.provide('tools' as never, {
      register: (def: { name: string }) => {
        registeredTools.push(def.name)
        return () => undefined
      },
    } as never)
    ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-principal',
        principalLineage: {
          principalRecordId: 'owner-1',
          principalVersion: 1,
        },
        sessionId: 'sess-1',
        scope: { workspace: workDir, preset: 'primary' },
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }),
    } as never)
    ctx.provide('assistantPolicy' as never, {
      registerPreauthorizedTool: (_rt: unknown, def: { name: string }) => { preauthorizedTools.push(def.name) },
      evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
    } as never)
    ctx.provide('credentialsKeychain' as never, {} as never)

    // Match principalDigest to sha256('owner-principal')
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const matchedUnsigned: ExternalActionGrantUnsigned = {
      ...shellGrantUnsigned,
      owner: { ...shellGrantUnsigned.owner, principalDigest: realDigest },
    }
    const matchedProjection = createActionGrantProjection(matchedUnsigned)

    let svc!: AssistantActionsService
    const plugin = await ctx.plugin({
      name: 'test-assistant-actions',
      apply(runtime: Context) {
        svc = new AssistantActionsService(runtime, {
          stateRoot,
          actionGrants: [matchedProjection],
        })
      },
    })
    try {
      expect(projection.id).toBe('shell-local-1')
      expect(registeredTools).toEqual([
        'action_broker_grants',
        'action_http_request',
        'action_lark_action',
        'action_calendar_action',
        'action_shell_exec',
      ])
      expect(preauthorizedTools).toEqual([])
      expect(svc.health().supportedDomains).toEqual(['github', 'http', 'lark', 'calendar', 'shell'])
      expect(svc.listActionGrants(fakeAgent as never)).toHaveLength(1)

      const execOut = await svc.executeAction(fakeAgent as never, {
        grantId: matchedProjection.id,
        idempotencyKey: 'exec-1',
        domain: 'shell',
        operation: 'shell.exec',
        destination: { classification: 'shell-command', executable: process.execPath, cwd: workDir },
        payload: { executable: process.execPath, args: ['-e', 'process.stdout.write("svc-ok")'], cwd: workDir, timeoutMs: 2_000 },
      }, new AbortController().signal)
      expect(execOut.status).toBe('succeeded')
      expect(execOut.result).toMatchObject({ domain: 'shell', exitCode: 0, stdout: 'svc-ok' })
    } finally {
      await plugin.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('tracks client request signature digest consistently with actionBrokerRequestDigest', () => {
    const now = 1_700_000_000_000
    const hello = createActionBrokerServerHello({ instanceId: 'b', generation: 1, policyEpoch: 0, emergencyEpoch: 0, expiresAt: now + 10_000 }, keys.privateKey)
    const req: ActionBrokerClientRequest = createActionBrokerClientRequest({
      actionId: 'a1',
      grantId: 'g1',
      grantRevision: 1,
      grantDigest: '1'.repeat(64),
      domain: 'http',
      owner: { principalDigest: '2'.repeat(64), principalRecordId: 'p1', principalVersion: 1, workspace: '/ws', preset: 'p', bindingId: 'b1', bindingVersion: 1, bindingGeneration: 1 },
      sessionId: 's1',
      agentId: 'ag1',
      rootCallId: 'r1',
      callId: 'c1',
      operation: 'http.request',
      source: { classification: 'internal', provenanceDigest: '3'.repeat(64) },
      destination: { classification: 'http-endpoint', scheme: 'https', host: 'api.example.test', path: '/v1' },
      payload: { method: 'GET', url: 'https://api.example.test/v1' },
      deadline: now + 5_000,
      budget: { reservationId: 'res1', actions: 1, bytes: 10, costMetric: 'http-requests', maxCostUnits: 1 },
    }, hello, { kind: 'assistant-actions-host', instanceId: 'h1', generation: 1 }, 'ck1', keys.privateKey)
    expect(req.signature).toBeTypeOf('string')
  })

  it('settles pre-dispatch guard rejections in ExternalBrokerCore as failed/dispatched:false without consuming lease budget', async () => {
    const now = Date.now()
    const root = await makeTempDir('broker-v2-predispatch-')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })

    const httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    try {
      const owner = {
        principalDigest: 'a'.repeat(64),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: workDir,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }
      const baseFields = {
        protocol: ACTION_GRANT_PROTOCOL,
        revision: 1,
        clientKeyId: 'client-v2',
        owner,
        sessionId: 'session-pre',
        expiresAt: now + 60_000,
        maxActions: 10,
        maxTotalBytes: 1_048_576,
        maxCostUnits: 10,
        client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
        source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
        policyEpoch: 1,
        emergencyEpoch: 0,
      }

      const httpGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-http-pre',
        domain: 'http',
        credentialId: 'no-secret',
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
        allowedOperations: ['http.request'],
        lease: { leaseId: 'lease-http-pre', expiresAtMs: now + 60_000, maxUses: 1 },
      } satisfies ExternalActionGrantUnsigned)

      const larkGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-lark-pre',
        domain: 'lark',
        credentialId: 'no-secret',
        destination: {
          classification: 'lark-workspace',
          tenantKey: 'tenant-1',
          apiBaseUrl: 'https://open.feishu.cn',
          allowedChatIds: ['oc_allowed'],
          allowedMsgTypes: ['text'],
          maxTextBytes: 128,
        },
        allowedOperations: ['lark.read-messages', 'lark.reply-message'],
        lease: { leaseId: 'lease-lark-pre', expiresAtMs: now + 60_000, maxUses: 1 },
      } satisfies ExternalActionGrantUnsigned)

      const calGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-cal-pre',
        domain: 'calendar',
        credentialId: 'no-secret',
        destination: {
          classification: 'calendar-scope',
          provider: 'lark-calendar',
          apiBaseUrl: 'https://open.feishu.cn',
          allowedCalendarIds: ['cal-main'],
          maxWindowSpanMs: 3_600_000,
          allowMutations: false,
          allowExternalAttendees: false,
        },
        allowedOperations: ['calendar.list-events', 'calendar.delete-event'],
        lease: { leaseId: 'lease-cal-pre', expiresAtMs: now + 60_000, maxUses: 1 },
      } satisfies ExternalActionGrantUnsigned)

      const shellGrant = withActionGrantDigest({
        ...baseFields,
        id: 'g-shell-pre',
        domain: 'shell',
        credentialId: 'no-secret',
        destination: {
          classification: 'shell-command',
          allowedCwds: [workDir],
          allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
          allowedEnvKeys: [],
          maxTimeoutMs: 5_000,
          maxStdoutBytes: 4_096,
          maxStderrBytes: 4_096,
          allowNetwork: false,
        },
        allowedOperations: ['shell.exec'],
        lease: { leaseId: 'lease-shell-pre', expiresAtMs: now + 60_000, maxUses: 1 },
      } satisfies ExternalActionGrantUnsigned)

      const core = new ExternalBrokerCore({
        instanceId: 'broker-pre',
        statePath: ':memory:',
        credentials: [{ id: 'no-secret', provider: 'injected-lease', maxLeaseMs: 30_000 }],
        grants: [],
        actionGrants: [httpGrant, larkGrant, calGrant, shellGrant],
        policyEpoch: 1,
        now: () => now,
      }, {
        lark: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ observed: { items: [] } }),
        },
        calendar: {
          now: () => now,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ observed: { items: [] } }),
        },
      })

      const hello = createActionBrokerServerHello({
        instanceId: 'broker-pre',
        generation: core.snapshot().generation,
        policyEpoch: 1,
        emergencyEpoch: 0,
        expiresAt: now + 30_000,
      }, serverKeys.privateKey)

      const signReq = (intent: ActionBrokerRequestIntent): ActionBrokerClientRequest => {
        const first = createActionBrokerClientRequest(intent, hello, baseFields.client, 'client-v2', clientKeys.privateKey, `req-${intent.actionId}`)
        return createActionBrokerClientRequest(
          { ...intent, budget: { ...intent.budget, bytes: brokerPayloadBytes(first) } },
          hello,
          baseFields.client,
          'client-v2',
          clientKeys.privateKey,
          `req-${intent.actionId}`,
        )
      }

      // 1. HTTP pre-dispatch failure settles as failed / dispatched:false and preserves maxUses=1
      const httpBad = await core.executeAction(signReq({
        actionId: 'pre-http-bad',
        grantId: httpGrant.id,
        grantRevision: 1,
        grantDigest: httpGrant.digest,
        domain: 'http',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-1',
        callId: 'call-http-bad',
        operation: 'http.request',
        source: baseFields.source,
        destination: { classification: 'http-endpoint', scheme: 'http', host: 'evil.example.test', path: '/v1/ping' },
        payload: { method: 'GET', url: 'http://evil.example.test/v1/ping' },
        deadline: now + 20_000,
        budget: { reservationId: 'res-http-bad', actions: 1, bytes: 0, costMetric: 'http-requests', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(httpBad).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'grant-invalid' } })

      const httpGood = await core.executeAction(signReq({
        actionId: 'pre-http-good',
        grantId: httpGrant.id,
        grantRevision: 1,
        grantDigest: httpGrant.digest,
        domain: 'http',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-1',
        callId: 'call-http-good',
        operation: 'http.request',
        source: baseFields.source,
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/ping' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/ping` },
        deadline: now + 20_000,
        budget: { reservationId: 'res-http-good', actions: 1, bytes: 0, costMetric: 'http-requests', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(httpGood).toMatchObject({ status: 'succeeded', dispatched: true })

      // 2. Lark pre-dispatch failure (mismatched receiveId on read-messages) settles as failed/dispatched:false and preserves maxUses=1
      const larkBad = await core.executeAction(signReq({
        actionId: 'pre-lark-bad',
        grantId: larkGrant.id,
        grantRevision: 1,
        grantDigest: larkGrant.digest,
        domain: 'lark',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-2',
        callId: 'call-lark-bad',
        operation: 'lark.read-messages',
        source: baseFields.source,
        destination: { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_other' },
        payload: { chatId: 'oc_allowed', pageSize: 10 },
        deadline: now + 20_000,
        budget: { reservationId: 'res-lark-bad', actions: 1, bytes: 0, costMetric: 'lark-api-calls', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(larkBad).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'request-invalid' } })

      const larkGood = await core.executeAction(signReq({
        actionId: 'pre-lark-good',
        grantId: larkGrant.id,
        grantRevision: 1,
        grantDigest: larkGrant.digest,
        domain: 'lark',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-2',
        callId: 'call-lark-good',
        operation: 'lark.read-messages',
        source: baseFields.source,
        destination: { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
        payload: { chatId: 'oc_allowed', pageSize: 10 },
        deadline: now + 20_000,
        budget: { reservationId: 'res-lark-good', actions: 1, bytes: 0, costMetric: 'lark-api-calls', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(larkGood).toMatchObject({ status: 'succeeded', dispatched: true })

      // 3. Calendar pre-dispatch failure (mutations disabled) settles as failed/dispatched:false and preserves maxUses=1
      const calBad = await core.executeAction(signReq({
        actionId: 'pre-cal-bad',
        grantId: calGrant.id,
        grantRevision: 1,
        grantDigest: calGrant.digest,
        domain: 'calendar',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-3',
        callId: 'call-cal-bad',
        operation: 'calendar.delete-event',
        source: baseFields.source,
        destination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        payload: { calendarId: 'cal-main', eventId: 'evt-1' },
        deadline: now + 20_000,
        budget: { reservationId: 'res-cal-bad', actions: 1, bytes: 0, costMetric: 'calendar-api-calls', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(calBad).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'grant-invalid' } })

      const calGood = await core.executeAction(signReq({
        actionId: 'pre-cal-good',
        grantId: calGrant.id,
        grantRevision: 1,
        grantDigest: calGrant.digest,
        domain: 'calendar',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-3',
        callId: 'call-cal-good',
        operation: 'calendar.list-events',
        source: baseFields.source,
        destination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        payload: { calendarId: 'cal-main', startTimeMs: now, endTimeMs: now + 60_000 },
        deadline: now + 20_000,
        budget: { reservationId: 'res-cal-good', actions: 1, bytes: 0, costMetric: 'calendar-api-calls', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(calGood).toMatchObject({ status: 'succeeded', dispatched: true })

      // 4. Shell pre-dispatch failure (disallowed executable) settles as failed/dispatched:false and preserves maxUses=1
      const shellBad = await core.executeAction(signReq({
        actionId: 'pre-shell-bad',
        grantId: shellGrant.id,
        grantRevision: 1,
        grantDigest: shellGrant.digest,
        domain: 'shell',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-4',
        callId: 'call-shell-bad',
        operation: 'shell.exec',
        source: baseFields.source,
        destination: { classification: 'shell-command', executable: '/bin/sh', cwd: workDir },
        payload: { executable: '/bin/sh', args: ['-c', 'echo nope'], cwd: workDir, timeoutMs: 1_000 },
        deadline: now + 20_000,
        budget: { reservationId: 'res-shell-bad', actions: 1, bytes: 0, costMetric: 'shell-exec-units', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(shellBad).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'grant-invalid' } })

      const shellGood = await core.executeAction(signReq({
        actionId: 'pre-shell-good',
        grantId: shellGrant.id,
        grantRevision: 1,
        grantDigest: shellGrant.digest,
        domain: 'shell',
        owner,
        sessionId: baseFields.sessionId,
        agentId: 'agent-1',
        rootCallId: 'root-4',
        callId: 'call-shell-good',
        operation: 'shell.exec',
        source: baseFields.source,
        destination: { classification: 'shell-command', executable: process.execPath, cwd: workDir },
        payload: { executable: process.execPath, args: ['-e', 'process.stdout.write("pre-shell-ok")'], cwd: workDir, timeoutMs: 3_000 },
        deadline: now + 20_000,
        budget: { reservationId: 'res-shell-good', actions: 1, bytes: 0, costMetric: 'shell-exec-units', maxCostUnits: 1 },
      }), new AbortController().signal)
      expect(shellGood).toMatchObject({ status: 'succeeded', dispatched: true })

      await core.close()
    } finally {
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('rolls back Host #wp08Usage on pre-dispatch errors, validates action_http_request protocol/IPv6 brackets, and forwards platform in broker-cli', async () => {
    const root = await makeTempDir('service-v2-fixes-')
    const stateRoot = join(root, 'state')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })
    const now = Date.now()

    const httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '::1', resolve))
    const ipv6Port = (httpServer.address() as { port: number }).port

    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const httpGrantUnsigned: ExternalActionGrantUnsigned = {
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'http-ipv6-1',
      revision: 1,
      domain: 'http',
      clientKeyId: 'host-1',
      owner: {
        principalDigest: realDigest,
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: workDir,
        preset: 'primary',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      },
      sessionId: 'sess-1',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['::1'],
        allowedPorts: [ipv6Port],
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
      lease: { leaseId: 'lease-host-1', expiresAtMs: now + 60_000, maxUses: 1 },
    }
    const httpProjection = createActionGrantProjection(httpGrantUnsigned)

    const registered = new Map<string, { execute: (args: Record<string, unknown>, execution: unknown) => Promise<{ result: string }> }>()
    const fakeAgent = { id: 'agent-1', session: { id: 'sess-1', header: { cwd: workDir, agentPreset: 'primary' } } }

    const ctx = new Context()
    ctx.provide('tools' as never, {
      register: (def: { name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<{ result: string }> }) => {
        registered.set(def.name, def)
        return () => undefined
      },
    } as never)
    ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-principal',
        principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        sessionId: 'sess-1',
        scope: { workspace: workDir, preset: 'primary' },
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }),
    } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
    } as never)
    ctx.provide('credentialsKeychain' as never, {} as never)

    let svc!: AssistantActionsService
    const plugin = await ctx.plugin({
      name: 'test-assistant-actions-fixes',
      apply(runtime: Context) {
        svc = new AssistantActionsService(runtime, {
          stateRoot,
          actionGrants: [httpProjection],
        })
      },
    })

    try {
      const httpTool = registered.get('action_http_request')!
      // Reject non-http/https schemes directly in tool wrapper
      await expect(httpTool.execute({
        grantId: httpProjection.id,
        idempotencyKey: 'bad-scheme',
        method: 'GET',
        url: 'ftp://[::1]/v1/ok',
      }, { agent: fakeAgent, signal: new AbortController().signal })).rejects.toThrow(/must use http or https/)

      // Pre-dispatch guard failure in executeAction does NOT consume #wp08Usage (maxUses=1 stays available)
      await expect(svc.executeAction(fakeAgent as never, {
        grantId: httpProjection.id,
        idempotencyKey: 'pre-bad',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: 'other.example.test', path: '/v1/ok' },
        payload: { method: 'GET', url: 'http://other.example.test/v1/ok' },
      }, new AbortController().signal)).rejects.toThrow(/not permitted/)

      // IPv6 literal URL through action_http_request strips brackets from host and succeeds (maxUses=1 not exhausted!)
      const toolOut = await httpTool.execute({
        grantId: httpProjection.id,
        idempotencyKey: 'ipv6-ok',
        method: 'GET',
        url: `http://[::1]:${ipv6Port}/v1/ok`,
      }, { agent: fakeAgent, signal: new AbortController().signal })
      expect(JSON.parse(toolOut.result)).toMatchObject({ status: 'succeeded', result: { statusCode: 200 } })

      // Verify broker-cli productionCore forwards config.platform (non-auto 'win32' triggers win32 ledger path/credential check)
      const cliDir = join(root, 'cli')
      await mkdir(cliDir, { mode: 0o700 })
      const pubPem = clientKeys.publicKey.export({ format: 'pem', type: 'spki' })
      const adminPubPem = adminKeys.publicKey.export({ format: 'pem', type: 'spki' })
      const srvPrivPem = serverKeys.privateKey.export({ format: 'pem', type: 'pkcs8' })
      const srvPrivPath = join(cliDir, 'srv.key')
      const cliPubPath = join(cliDir, 'cli.pub')
      const admPubPath = join(cliDir, 'adm.pub')
      const cfgPath = join(cliDir, 'serve.json')
      await Promise.all([
        writeFile(srvPrivPath, srvPrivPem, { mode: 0o600 }),
        writeFile(cliPubPath, pubPem, { mode: 0o600 }),
        writeFile(admPubPath, adminPubPem, { mode: 0o600 }),
      ])
      await writeFile(cfgPath, JSON.stringify({
        actionSocketPath: '\\\\.\\pipe\\dsh-test-action',
        adminSocketPath: '\\\\.\\pipe\\dsh-test-admin',
        brokerId: 'broker-win',
        minimumBrokerGeneration: 1,
        serverPrivateKeyPath: srvPrivPath,
        clientKeyId: 'cli-1',
        clientPublicKeyPath: cliPubPath,
        adminKeyId: 'adm-1',
        adminPublicKeyPath: admPubPath,
        statePath: join(cliDir, 'broker.sqlite'),
        expectedClientPeerUid: 0,
        expectedClientPeerGid: 0,
        expectedAdminPeerUid: 0,
        expectedAdminPeerGid: 0,
        expectedActionSocketUid: 0,
        expectedActionSocketGid: 0,
        expectedActionParentMode: 0o700,
        expectedActionSocketMode: 0o600,
        expectedAdminSocketUid: 0,
        expectedAdminSocketGid: 0,
        expectedAdminParentMode: 0o700,
        expectedAdminSocketMode: 0o600,
        maxActionConnections: 4,
        maxAdminConnections: 2,
        maxConcurrentRequests: 2,
        requestTimeoutMs: 5_000,
        helloTtlMs: 5_000,
        drainTimeoutMs: 1_000,
        credentials: [{ id: 'c1', provider: 'linux-protected-file', path: cliPubPath, maxLeaseMs: 10_000 }],
        grants: [],
        policyEpoch: 1,
        platform: 'win32',
        transport: 'windows-pipe',
      }), { mode: 0o600 })
      const stderrChunks: string[] = []
      const exitCode = await runBrokerCli(['serve', cfgPath], {
        peerCredentialsAvailable: () => true,
        peerInspector: () => ({ uid: 0, gid: 0, pid: 1, sid: 'S-1-5-21-1' }),
        stderr: { write: (chunk: unknown) => { stderrChunks.push(String(chunk)); return true } } as unknown as Pick<NodeJS.WriteStream, 'write'>,
      })
      // Forwarded platform:'win32' rejects linux-protected-file in productionCore -> exits 1
      expect(exitCode).toBe(1)
      expect(stderrChunks.join('')).toContain('command failed')
    } finally {
      await plugin.dispose()
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('rolls back #wp08Usage on pre-dispatch BrokerClientError in external-v2 mode and preserves usage when postDispatchUnknown is true', async () => {
    const root = await makeTempDir('v2-er-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    const httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const baseGrant = {
      protocol: ACTION_GRANT_PROTOCOL,
      revision: 1,
      domain: 'http' as const,
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-ext-1',
      destination: {
        classification: 'http-endpoint' as const,
        allowedSchemes: ['http' as const],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [port],
        allowedMethods: ['GET' as const],
        allowedPathPrefixes: ['/v1/'],
        allowRedirects: false as const,
        allowPrivateNetwork: true,
        maxResponseBytes: 4_096,
      },
      credentialId: 'no-secret',
      expiresAt: now + 60_000,
      maxActions: 5,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 5,
      allowedOperations: ['http.request' as const],
      client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
      monetaryCostCapMicros: 100,
    }

    const grant1Unsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'ext-lease-1',
      lease: { leaseId: 'lease-ext-1', expiresAtMs: now + 60_000, maxUses: 1 },
    }
    const grant2Unsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'ext-lease-2',
      lease: { leaseId: 'lease-ext-2', expiresAtMs: now + 60_000, maxUses: 1 },
    }
    const grant3Unsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'ext-lease-3',
      lease: { leaseId: 'lease-ext-3', expiresAtMs: now + 60_000, maxUses: 1 },
    }

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-ext-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const makeCtx = (): Context => {
      const ctx = new Context()
      ctx.provide('tools' as never, { register: () => () => undefined } as never)
      ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
      ctx.provide('assistantDelivery' as never, {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-principal',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-ext-1',
          scope: { workspace: workDir, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      } as never)
      return ctx
    }

    const socketPath = join(sockDir, 'action.sock')
    const adminSocketPath = join(sockDir, 'admin.sock')
    const baseBrokerConfig = {
      mode: 'external-v2' as const,
      actionSocketPath: socketPath,
      brokerId: 'broker-v2',
      brokerPublicKeyPath: brokerPubPath,
      clientKeyId: 'client-v2',
      clientSigningKeyPath: clientPrivPath,
      clientInstanceId: 'host-v2',
      clientGeneration: 1,
      expectedSocketUid: uid,
      expectedSocketGid: gid,
      expectedSocketParentUid: uid,
      expectedSocketParentGid: gid,
      expectedBrokerPeerUid: uid,
      expectedBrokerPeerGid: gid,
      platform: (process.platform === 'darwin' ? 'darwin' : 'linux') as 'darwin' | 'linux',
      transport: 'posix-uds' as const,
    }

    const ctxInj = makeCtx()
    let mode: 'pre-dispatch-client-err' | 'post-dispatch-unknown' | 'pre-dispatch-plain-err' | 'succeed' = 'pre-dispatch-client-err'
    let injSvc!: AssistantActionsService
    const injPlugin = await ctxInj.plugin({
      name: 'test-ext-rollback-injected',
      apply(runtime: Context) {
        injSvc = new AssistantActionsService(
          runtime,
          {
            stateRoot: join(root, 'host-state-inj'),
            externalActionGrants: [
              createActionGrantProjection(grant1Unsigned),
              createActionGrantProjection(grant2Unsigned),
              createActionGrantProjection(grant3Unsigned),
            ],
            broker: baseBrokerConfig,
          },
          undefined,
          undefined,
          undefined,
          undefined,
          async (_opts, intent) => {
            if (mode === 'pre-dispatch-client-err') {
              throw new BrokerClientError('socket-invalid', 'not-dispatched', 'missing socket')
            }
            if (mode === 'post-dispatch-unknown') {
              throw new BrokerPostDispatchUnknownError('disconnected', 'dropped after write')
            }
            if (mode === 'pre-dispatch-plain-err') {
              throw new Error('ENOENT: broker socket unavailable')
            }
            const res: ActionBrokerServerResponse = {
              protocol: ACTION_BROKER_PROTOCOL,
              type: 'server-response',
              requestId: 'req-1',
              actionId: intent.actionId,
              instanceId: 'broker-v2',
              generation: 1,
              challenge: Buffer.alloc(32).toString('base64url'),
              requestDigest: 'e'.repeat(64),
              status: 'succeeded',
              dispatched: true,
              result: {
                domain: 'http',
                operation: 'http.request',
                statusCode: 200,
                responseHeaders: {},
                body: '{"ok":true}',
                bodySha256: 'd'.repeat(64),
                truncated: false,
                untrusted: true,
              },
              error: null,
              completedAt: Date.now(),
              signature: Buffer.alloc(64).toString('base64url'),
            }
            return res
          },
        )
      },
    })

    try {
      const reqFor = (grantId: string, idempotencyKey: string) => ({
        grantId,
        idempotencyKey,
        domain: 'http' as const,
        operation: 'http.request' as const,
        destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/v1/ping' },
        payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/ping` },
        estimatedCostMicros: 80,
      })

      // 1. Pre-dispatch BrokerClientError (postDispatchUnknown === false) rolls back usage
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-1', 'k1'), new AbortController().signal))
        .rejects.toMatchObject({ postDispatchUnknown: false, code: 'socket-invalid' })
      mode = 'succeed'
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-1', 'k2'), new AbortController().signal))
        .resolves.toMatchObject({ status: 'succeeded' })

      // 2. Post-dispatch unknown BrokerClientError (postDispatchUnknown === true) MUST NOT roll back
      mode = 'post-dispatch-unknown'
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-2', 'k3'), new AbortController().signal))
        .rejects.toMatchObject({ postDispatchUnknown: true })
      mode = 'succeed'
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-2', 'k4'), new AbortController().signal))
        .rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/)

      // 3. Non-BrokerClientError thrown pre-dispatch also rolls back usage
      mode = 'pre-dispatch-plain-err'
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-3', 'k5'), new AbortController().signal))
        .rejects.toThrow(/ENOENT/)
      mode = 'succeed'
      await expect(injSvc.executeAction(fakeAgent as never, reqFor('ext-lease-3', 'k6'), new AbortController().signal))
        .resolves.toMatchObject({ status: 'succeeded' })

      // 4. Real requestActionBroker with missing socket -> real BrokerClientError(postDispatchUnknown=false),
      //    followed by starting real ExternalBrokerCore server on the socket -> subsequent call succeeds.
      if (process.platform === 'linux') {
        const ctxReal = makeCtx()
        let realSvc!: AssistantActionsService
        const realPlugin = await ctxReal.plugin({
          name: 'test-ext-rollback-real',
          apply(runtime: Context) {
            realSvc = new AssistantActionsService(runtime, {
              stateRoot: join(root, 'host-state-real'),
              externalActionGrants: [createActionGrantProjection(grant1Unsigned)],
              broker: baseBrokerConfig,
            })
          },
        })
        try {
          await expect(realSvc.executeAction(fakeAgent as never, reqFor('ext-lease-1', 'real-k1'), new AbortController().signal))
            .rejects.toMatchObject({ name: 'BrokerClientError', postDispatchUnknown: false, code: 'socket-invalid' })

          const grant1Signed = withActionGrantDigest(grant1Unsigned)
          const core = new ExternalBrokerCore({
            instanceId: 'broker-v2',
            statePath: ':memory:',
            credentials: [{ id: 'no-secret', provider: 'injected-lease', maxLeaseMs: 30_000 }],
            grants: [],
            actionGrants: [grant1Signed],
            policyEpoch: 1,
          })
          const peer: BrokerPeerCredentialInspector = () => ({ uid, gid, pid: process.pid })
          const server = await startGitHubBrokerServer({
            actionSocketPath: socketPath,
            adminSocketPath,
            instanceId: 'broker-v2',
            generation: core.snapshot().generation,
            serverPrivateKey: serverKeys.privateKey,
            clientPublicKey: clientKeys.publicKey,
            clientKeyId: 'client-v2',
            adminPublicKey: adminKeys.publicKey,
            adminKeyId: 'admin-v2',
            core,
            inspectPeerCredentials: peer,
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
            protocolMode: 'action-v2',
          })
          servers.push(server)

          await expect(realSvc.executeAction(fakeAgent as never, reqFor('ext-lease-1', 'real-k2'), new AbortController().signal))
            .resolves.toMatchObject({ status: 'succeeded' })
        } finally {
          await realPlugin.dispose()
          await ctxReal.fiber.dispose()
        }
      }
    } finally {
      await injPlugin.dispose()
      await ctxInj.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('preserves concurrent lastSettledCommitDigest during rollbackUsage so mismatched predecessorDigest is rejected', async () => {
    const root = await makeTempDir('v2-cr-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const chainGrantUnsigned: ExternalActionGrantUnsigned = {
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'ext-chain-1',
      revision: 1,
      domain: 'http',
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-chain-1',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [8080],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 4_096,
      },
      credentialId: 'no-secret',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 10,
      allowedOperations: ['http.request'],
      client: { kind: 'assistant-actions-host', instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
      lease: { leaseId: 'lease-chain-1', expiresAtMs: now + 60_000, maxUses: 5 },
    }

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-chain-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const ctx = new Context()
    ctx.provide('tools' as never, { register: () => () => undefined } as never)
    ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-principal',
        principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        sessionId: 'sess-chain-1',
        scope: { workspace: workDir, preset: 'primary' },
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }),
    } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
    } as never)

    let releaseReq1!: () => void
    const req1Gate = new Promise<void>(resolve => { releaseReq1 = resolve })
    let releaseReq2!: () => void
    const req2Gate = new Promise<void>(resolve => { releaseReq2 = resolve })
    let bothStarted = 0
    let notifyBothStarted!: () => void
    const bothStartedPromise = new Promise<void>(resolve => { notifyBothStarted = resolve })

    const makeResp = (actionId: string, status: 'succeeded' | 'failed'): ActionBrokerServerResponse => ({
      protocol: ACTION_BROKER_PROTOCOL,
      type: 'server-response',
      requestId: `req-${actionId}`,
      actionId,
      instanceId: 'broker-v2',
      generation: 1,
      challenge: Buffer.alloc(32).toString('base64url'),
      requestDigest: 'e'.repeat(64),
      status,
      dispatched: status === 'succeeded',
      result: status === 'succeeded'
        ? {
          domain: 'http',
          operation: 'http.request',
          statusCode: 200,
          responseHeaders: {},
          body: '{"ok":true}',
          bodySha256: 'd'.repeat(64),
          truncated: false,
          untrusted: true,
        }
        : null,
      error: status === 'succeeded' ? null : { code: 'grant-invalid' },
      completedAt: Date.now(),
      signature: Buffer.alloc(64).toString('base64url'),
    })

    let svc!: AssistantActionsService
    const plugin = await ctx.plugin({
      name: 'test-concurrent-rollback-digest',
      apply(runtime: Context) {
        svc = new AssistantActionsService(
          runtime,
          {
            stateRoot: join(root, 'host-state'),
            externalActionGrants: [createActionGrantProjection(chainGrantUnsigned)],
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
              platform: process.platform === 'darwin' ? 'darwin' : 'linux',
              transport: 'posix-uds',
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          async (_opts, intent) => {
            if (intent.idempotencyKey === 'req-1') {
              bothStarted += 1
              if (bothStarted === 2) notifyBothStarted()
              await req1Gate
              return makeResp(intent.actionId, 'succeeded')
            }
            if (intent.idempotencyKey === 'req-2') {
              bothStarted += 1
              if (bothStarted === 2) notifyBothStarted()
              await req2Gate
              return makeResp(intent.actionId, 'failed')
            }
            return makeResp(intent.actionId, 'succeeded')
          },
        )
      },
    })

    try {
      const digestA = 'a'.repeat(64)
      const digestB = 'b'.repeat(64)
      const baseReq = {
        grantId: 'ext-chain-1',
        domain: 'http' as const,
        operation: 'http.request' as const,
        destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port: 8080, path: '/v1/ping' },
        payload: { method: 'GET' as const, url: 'http://127.0.0.1:8080/v1/ping' },
      }

      // Start Req 1 and Req 2 concurrently before either settles (both snapshot lastSettledCommitDigest = undefined)
      const p1 = svc.executeAction(fakeAgent as never, { ...baseReq, idempotencyKey: 'req-1', commitDigest: digestA }, new AbortController().signal)
      const p2 = svc.executeAction(fakeAgent as never, { ...baseReq, idempotencyKey: 'req-2' }, new AbortController().signal)
      await bothStartedPromise

      // Req 1 settles first and records lastSettledCommitDigest = digestA
      releaseReq1()
      await expect(p1).resolves.toMatchObject({ status: 'succeeded' })

      // Req 2 settles second as pre-dispatch failure and triggers rollbackUsage()
      releaseReq2()
      await expect(p2).resolves.toMatchObject({ status: 'failed' })

      // Req 3 with mismatched predecessorDigest must still be rejected
      await expect(svc.executeAction(fakeAgent as never, {
        ...baseReq,
        idempotencyKey: 'req-3',
        predecessorDigest: digestB,
      }, new AbortController().signal)).rejects.toThrow(/WP08 policy rejected \(predecessor-digest-mismatch\)/)

      // Req 4 with matching predecessorDigest succeeds
      await expect(svc.executeAction(fakeAgent as never, {
        ...baseReq,
        idempotencyKey: 'req-4',
        predecessorDigest: digestA,
      }, new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
    } finally {
      await plugin.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not consume external-v2 maxUses=1 lease when canonicalBrokerJson throws BrokerProtocolError on forbidden HTTP headers or fractional shell timeoutMs', async () => {
    const root = await makeTempDir('v2-cn-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const baseFields = {
      protocol: ACTION_GRANT_PROTOCOL,
      revision: 1,
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-canon-1',
      credentialId: 'no-secret',
      expiresAt: now + 60_000,
      maxActions: 5,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 5,
      client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
    }

    const httpGrantUnsigned: ExternalActionGrantUnsigned = {
      ...baseFields,
      id: 'ext-canon-http-1',
      domain: 'http',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [8080],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 4_096,
      },
      allowedOperations: ['http.request'],
      lease: { leaseId: 'lease-canon-http-1', expiresAtMs: now + 60_000, maxUses: 1 },
    }

    const shellGrantUnsigned: ExternalActionGrantUnsigned = {
      ...baseFields,
      id: 'ext-canon-shell-1',
      domain: 'shell',
      destination: {
        classification: 'shell-command',
        allowedCwds: [workDir],
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
        allowNetwork: false,
      },
      allowedOperations: ['shell.exec'],
      lease: { leaseId: 'lease-canon-shell-1', expiresAtMs: now + 60_000, maxUses: 1 },
    }

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-canon-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const registered = new Map<string, { execute: (args: Record<string, unknown>, execution: unknown) => Promise<{ result: string }> }>()
    const ctx = new Context()
    ctx.provide('tools' as never, {
      register: (def: { name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<{ result: string }> }) => {
        registered.set(def.name, def)
        return () => undefined
      },
    } as never)
    ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-principal',
        principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
        sessionId: 'sess-canon-1',
        scope: { workspace: workDir, preset: 'primary' },
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
      }),
    } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
    } as never)

    let dispatchCount = 0
    const plugin = await ctx.plugin({
      name: 'test-external-v2-canonical-no-leak',
      apply(runtime: Context) {
        new AssistantActionsService(
          runtime,
          {
            stateRoot: join(root, 'host-state'),
            externalActionGrants: [
              createActionGrantProjection(httpGrantUnsigned),
              createActionGrantProjection(shellGrantUnsigned),
            ],
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
              platform: process.platform === 'darwin' ? 'darwin' : 'linux',
              transport: 'posix-uds',
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          async (_opts, intent) => {
            dispatchCount += 1
            return {
              protocol: ACTION_BROKER_PROTOCOL,
              type: 'server-response',
              requestId: `req-${intent.actionId}`,
              actionId: intent.actionId,
              instanceId: 'broker-v2',
              generation: 1,
              challenge: Buffer.alloc(32).toString('base64url'),
              requestDigest: 'e'.repeat(64),
              status: 'succeeded',
              dispatched: true,
              result: intent.domain === 'http'
                ? {
                  domain: 'http',
                  operation: 'http.request',
                  statusCode: 200,
                  responseHeaders: {},
                  body: '{"ok":true}',
                  bodySha256: 'd'.repeat(64),
                  truncated: false,
                  untrusted: true,
                }
                : {
                  domain: 'shell',
                  operation: 'shell.exec',
                  exitCode: 0,
                  stdout: 'ok',
                  stderr: '',
                  stdoutSha256: 'd'.repeat(64),
                  stderrSha256: 'd'.repeat(64),
                  truncated: false,
                  untrusted: true,
                },
              error: null,
              completedAt: Date.now(),
              signature: Buffer.alloc(64).toString('base64url'),
            }
          },
        )
      },
    })

    try {
      const httpTool = registered.get('action_http_request')!
      const shellTool = registered.get('action_shell_exec')!

      // 1. action_http_request with forbidden authorization header throws BrokerProtocolError without consuming maxUses=1
      await expect(httpTool.execute({
        grantId: 'ext-canon-http-1',
        idempotencyKey: 'http-bad-header',
        method: 'GET',
        url: 'http://127.0.0.1:8080/v1/ping',
        headers: { authorization: 'Bearer test' },
      }, { agent: fakeAgent, signal: new AbortController().signal })).rejects.toBeInstanceOf(BrokerProtocolError)
      expect(dispatchCount).toBe(0)

      // Subsequent valid action_http_request succeeds on the same maxUses=1 grant
      const httpOk = await httpTool.execute({
        grantId: 'ext-canon-http-1',
        idempotencyKey: 'http-good',
        method: 'GET',
        url: 'http://127.0.0.1:8080/v1/ping',
      }, { agent: fakeAgent, signal: new AbortController().signal })
      expect(JSON.parse(httpOk.result)).toMatchObject({ status: 'succeeded', result: { statusCode: 200 } })
      expect(dispatchCount).toBe(1)

      // 2. action_shell_exec with fractional timeoutMs throws BrokerProtocolError without consuming maxUses=1
      await expect(shellTool.execute({
        grantId: 'ext-canon-shell-1',
        idempotencyKey: 'shell-bad-timeout',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: workDir,
        timeoutMs: 1500.5,
      }, { agent: fakeAgent, signal: new AbortController().signal })).rejects.toBeInstanceOf(BrokerProtocolError)
      expect(dispatchCount).toBe(1)

      // Subsequent valid action_shell_exec succeeds on the same maxUses=1 grant
      const shellOk = await shellTool.execute({
        grantId: 'ext-canon-shell-1',
        idempotencyKey: 'shell-good',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: workDir,
        timeoutMs: 1500,
      }, { agent: fakeAgent, signal: new AbortController().signal })
      expect(JSON.parse(shellOk.result)).toMatchObject({ status: 'succeeded', result: { exitCode: 0, stdout: 'ok' } })
      expect(dispatchCount).toBe(2)
    } finally {
      await plugin.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid estimatedCostMicros pre-dispatch without poisoning #wp08Usage when monetaryCostCapMicros is omitted', async () => {
    const root = await makeTempDir('v2-cg-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    let httpHits = 0
    const httpServer = createServer((_req, res) => {
      httpHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const noCapGrantUnsigned: ExternalActionGrantUnsigned = {
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'ext-no-cap-1',
      revision: 1,
      domain: 'http',
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-nocap-1',
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
      client: { kind: 'assistant-actions-host', instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
      lease: { leaseId: 'lease-nocap-1', expiresAtMs: now + 60_000, maxUses: 2 },
    }
    const noCapProjection = createActionGrantProjection(noCapGrantUnsigned)

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-nocap-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const makeCtx = (): Context => {
      const ctx = new Context()
      ctx.provide('tools' as never, { register: () => () => undefined } as never)
      ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
      ctx.provide('assistantDelivery' as never, {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-principal',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-nocap-1',
          scope: { workspace: workDir, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      } as never)
      ctx.provide('credentialsKeychain' as never, {} as never)
      return ctx
    }

    const baseReq = {
      grantId: noCapProjection.id,
      domain: 'http' as const,
      operation: 'http.request' as const,
      destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/v1/ping' },
      payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/ping` },
    }

    // 1. external-v2 mode
    const extCtx = makeCtx()
    let extDispatches = 0
    let extSvc!: AssistantActionsService
    const extPlugin = await extCtx.plugin({
      name: 'test-ext-v2-cost-guard',
      apply(runtime: Context) {
        extSvc = new AssistantActionsService(
          runtime,
          {
            stateRoot: join(root, 'ext-state'),
            externalActionGrants: [noCapProjection],
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
              platform: process.platform === 'darwin' ? 'darwin' : 'linux',
              transport: 'posix-uds',
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          async (_opts, intent) => {
            extDispatches += 1
            return {
              protocol: ACTION_BROKER_PROTOCOL,
              type: 'server-response',
              requestId: `req-${intent.actionId}`,
              actionId: intent.actionId,
              instanceId: 'broker-v2',
              generation: 1,
              challenge: Buffer.alloc(32).toString('base64url'),
              requestDigest: 'e'.repeat(64),
              status: 'succeeded',
              dispatched: true,
              result: {
                domain: 'http',
                operation: 'http.request',
                statusCode: 200,
                responseHeaders: {},
                body: '{"ok":true}',
                bodySha256: 'd'.repeat(64),
                truncated: false,
                untrusted: true,
              },
              error: null,
              completedAt: Date.now(),
              signature: Buffer.alloc(64).toString('base64url'),
            }
          },
        )
      },
    })

    // 2. embedded-compat mode
    const embCtx = makeCtx()
    let embSvc!: AssistantActionsService
    const embPlugin = await embCtx.plugin({
      name: 'test-emb-cost-guard',
      apply(runtime: Context) {
        embSvc = new AssistantActionsService(runtime, {
          stateRoot: join(root, 'emb-state'),
          actionGrants: [noCapProjection],
        })
      },
    })

    try {
      await expect(extSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'ext-nan', estimatedCostMicros: Number.NaN },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      await expect(extSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'ext-neg0', estimatedCostMicros: -0 },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      expect(extDispatches).toBe(0)

      await expect(extSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'ext-ok-1', estimatedCostMicros: 0 },
        new AbortController().signal,
      )).resolves.toMatchObject({ status: 'succeeded' })
      await expect(extSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'ext-ok-2', estimatedCostMicros: 0 },
        new AbortController().signal,
      )).resolves.toMatchObject({ status: 'succeeded' })
      expect(extDispatches).toBe(2)

      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-float', estimatedCostMicros: 1.5 },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-neg', estimatedCostMicros: -5 },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-nan', estimatedCostMicros: Number.NaN },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-neg0', estimatedCostMicros: -0 },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      expect(httpHits).toBe(0)

      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-ok-1', estimatedCostMicros: 0 },
        new AbortController().signal,
      )).resolves.toMatchObject({ status: 'succeeded' })
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'emb-ok-2', estimatedCostMicros: 0 },
        new AbortController().signal,
      )).resolves.toMatchObject({ status: 'succeeded' })
      expect(httpHits).toBe(2)
    } finally {
      await extPlugin.dispose()
      await extCtx.fiber.dispose()
      await embPlugin.dispose()
      await embCtx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it.skipIf(process.platform !== 'linux')('rejects cross-restart spentCostMicros overflow cleanly in real-UDS ExternalBrokerCore without poisoning SQLite SUM or remaining grant uses', async () => {
    const root = await makeTempDir('svc-v2-cross-restart-overflow-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const brokerDir = join(root, 'broker')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(brokerDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    let httpHits = 0
    const httpServer = createServer((_req, res) => {
      httpHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hits: httpHits }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-principal').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const noCapGrantUnsigned: ExternalActionGrantUnsigned = {
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'ext-cross-restart-nocap-1',
      revision: 1,
      domain: 'http',
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-xrestart-1',
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
      credentialId: 'no-secret',
      expiresAt: now + 60_000,
      maxActions: 5,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 5,
      allowedOperations: ['http.request'],
      client: { kind: 'assistant-actions-host', instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
      lease: { leaseId: 'lease-xrestart-nocap-1', expiresAtMs: now + 60_000, maxUses: 5 },
    }
    const noCapSigned = withActionGrantDigest(noCapGrantUnsigned)
    const noCapProjection = createActionGrantProjection(noCapGrantUnsigned)

    const core = new ExternalBrokerCore({
      instanceId: 'broker-v2',
      statePath: join(brokerDir, 'ledger.sqlite'),
      credentials: [{ id: 'no-secret', provider: 'injected-lease', maxLeaseMs: 30_000 }],
      grants: [],
      actionGrants: [noCapSigned],
      policyEpoch: 1,
    })
    const socketPath = join(sockDir, 'action.sock')
    const adminSocketPath = join(sockDir, 'admin.sock')
    const peer: BrokerPeerCredentialInspector = () => ({ uid, gid, pid: process.pid })
    const server = await startGitHubBrokerServer({
      actionSocketPath: socketPath,
      adminSocketPath,
      instanceId: 'broker-v2',
      generation: core.snapshot().generation,
      serverPrivateKey: serverKeys.privateKey,
      clientPublicKey: clientKeys.publicKey,
      clientKeyId: 'client-v2',
      adminPublicKey: adminKeys.publicKey,
      adminKeyId: 'admin-v2',
      core,
      inspectPeerCredentials: peer,
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
      protocolMode: 'action-v2',
    })
    servers.push(server)

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-xrestart-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const startHost = async (stateSubdir: string): Promise<{ ctx: Context; svc: AssistantActionsService; plugin: { dispose: () => Promise<void> } }> => {
      const ctx = new Context()
      ctx.provide('tools' as never, { register: () => () => undefined } as never)
      ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
      ctx.provide('assistantDelivery' as never, {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-principal',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-xrestart-1',
          scope: { workspace: workDir, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      } as never)
      ctx.provide('credentialsKeychain' as never, {} as never)

      let svc!: AssistantActionsService
      const plugin = await ctx.plugin({
        name: `test-host-${stateSubdir}`,
        apply(runtime: Context) {
          svc = new AssistantActionsService(runtime, {
            stateRoot: join(root, stateSubdir),
            externalActionGrants: [noCapProjection],
            broker: {
              mode: 'external-v2',
              actionSocketPath: socketPath,
              brokerId: 'broker-v2',
              brokerPublicKeyPath: brokerPubPath,
              clientKeyId: 'client-v2',
              clientSigningKeyPath: clientPrivPath,
              clientInstanceId: 'host-v2',
              clientGeneration: 1,
              expectedSocketUid: uid,
              expectedSocketGid: gid,
              expectedSocketParentUid: uid,
              expectedSocketParentGid: gid,
              expectedBrokerPeerUid: uid,
              expectedBrokerPeerGid: gid,
              platform: 'linux',
              transport: 'posix-uds',
            },
          })
        },
      })
      return { ctx, svc, plugin }
    }

    const baseReq = {
      grantId: noCapProjection.id,
      domain: 'http' as const,
      operation: 'http.request' as const,
      destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/v1/ping' },
      payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/ping` },
    }

    const host1 = await startHost('host-1')
    try {
      const r1 = await host1.svc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'xrestart-1', estimatedCostMicros: Number.MAX_SAFE_INTEGER },
        new AbortController().signal,
      )
      expect(r1).toMatchObject({ status: 'succeeded' })
      expect(httpHits).toBe(1)
    } finally {
      await host1.plugin.dispose()
      await host1.ctx.fiber.dispose()
    }

    // host2 starts with fresh in-memory #wp08Usage while ExternalBrokerCore retains SQLite SUM(estimated_cost_micros) = MAX_SAFE_INTEGER
    const host2 = await startHost('host-2')
    try {
      const r2 = await host2.svc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'xrestart-2', estimatedCostMicros: 1 },
        new AbortController().signal,
      )
      expect(r2).toMatchObject({ status: 'failed', reason: 'external-broker-request-invalid' })
      expect(httpHits).toBe(1)

      const r3 = await host2.svc.executeAction(
        fakeAgent as never,
        { ...baseReq, idempotencyKey: 'xrestart-3', estimatedCostMicros: 0 },
        new AbortController().signal,
      )
      expect(r3).toMatchObject({ status: 'succeeded' })
      expect(httpHits).toBe(2)
    } finally {
      await host2.plugin.dispose()
      await host2.ctx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('enforces per-request sensitivity escalation, anti-downgrade, and HTTP query-string pinning on executeAction and ExternalBrokerCore', async () => {
    const now = Date.now()
    const root = await makeTempDir('v2-pin-')
    const credDir = join(root, 'creds')
    const sockDir = join(root, 's')
    const adminDir = join(root, 'a')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(credDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(adminDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const tokenPath = join(credDir, 'api.token')
    await writeFile(tokenPath, 'v2_secret_token_pin', { mode: 0o600 })
    await chmod(tokenPath, 0o600)

    let httpHits = 0
    const seenUrls: string[] = []
    const httpServer = createServer((req, res) => {
      httpHits += 1
      seenUrls.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const brokerPubPath = join(root, 'broker.pub.pem')
    const clientPrivPath = join(root, 'client.priv.pem')
    await writeFile(brokerPubPath, serverKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    await writeFile(clientPrivPath, clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

    const owner = {
      principalDigest: createHash('sha256').update('owner-principal').digest('hex'),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const baseGrant = {
      protocol: ACTION_GRANT_PROTOCOL,
      revision: 1,
      domain: 'http' as const,
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-pin-1',
      destination: {
        classification: 'http-endpoint' as const,
        allowedSchemes: ['http' as const],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [port],
        allowedMethods: ['GET' as const],
        allowedPathPrefixes: ['/v1/'],
        allowRedirects: false as const,
        allowPrivateNetwork: true,
        maxResponseBytes: 8_192,
      },
      credentialId: 'no-secret',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 10,
      allowedOperations: ['http.request' as const],
      client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
      policyEpoch: 1,
      emergencyEpoch: 0,
    }

    const pinnedGrantUnsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'g-pin-internal',
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      destinations: [`http://127.0.0.1:${port}/v1/report?mode=read`],
      maxSensitivity: 'internal',
      lease: { leaseId: 'lease-pin-1', expiresAtMs: now + 60_000, maxUses: 1 },
    }
    const restrictedGrantUnsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'g-pin-restricted',
      source: { classification: 'restricted', provenanceDigest: 'c'.repeat(64) },
      maxSensitivity: 'internal',
      lease: { leaseId: 'lease-pin-2', expiresAtMs: now + 60_000, maxUses: 1 },
    }
    const unconstrainedSensGrantUnsigned: ExternalActionGrantUnsigned = {
      ...baseGrant,
      id: 'g-pin-no-max-sens',
      source: { classification: 'internal', provenanceDigest: 'd'.repeat(64) },
      lease: { leaseId: 'lease-pin-3', expiresAtMs: now + 60_000, maxUses: 1 },
    }

    const pinnedGrant = withActionGrantDigest(pinnedGrantUnsigned)
    const pinnedProj = createActionGrantProjection(pinnedGrantUnsigned)
    const restrictedProj = createActionGrantProjection(restrictedGrantUnsigned)
    const unconstrainedProj = createActionGrantProjection(unconstrainedSensGrantUnsigned)

    const fakeAgent = { id: 'agent-1', session: { id: 'sess-pin-1', header: { cwd: workDir, agentPreset: 'primary' } } }
    const makeCtx = (): Context => {
      const ctx = new Context()
      ctx.provide('tools' as never, { register: () => () => undefined } as never)
      ctx.provide('agents' as never, { get: (id: string) => id === 'agent-1' ? fakeAgent : undefined } as never)
      ctx.provide('assistantDelivery' as never, {
        preferencePrincipalForAgent: () => ({
          principalId: 'owner-principal',
          principalLineage: { principalRecordId: 'owner-1', principalVersion: 1 },
          sessionId: 'sess-pin-1',
          scope: { workspace: workDir, preset: 'primary' },
          bindingId: 'binding-1',
          bindingVersion: 1,
          bindingGeneration: 1,
        }),
      } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
        authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r1' }),
      } as never)
      ctx.provide('credentialsKeychain' as never, {} as never)
      return ctx
    }

    const embCtx = makeCtx()
    let embSvc!: AssistantActionsService
    const embPlugin = await embCtx.plugin({
      name: 'test-emb-pin',
      apply(runtime: Context) {
        embSvc = new AssistantActionsService(runtime, {
          stateRoot: join(root, 'emb-state'),
          actionGrants: [pinnedProj, restrictedProj, unconstrainedProj],
        })
      },
    })

    const core = new ExternalBrokerCore({
      instanceId: 'broker-v2',
      statePath: join(root, 'broker.sqlite'),
      credentials: [{ id: 'no-secret', provider: 'injected-lease', maxLeaseMs: 30_000 }],
      grants: [],
      actionGrants: [pinnedGrant],
      policyEpoch: 1,
    })
    const peer: BrokerPeerCredentialInspector = () => ({ uid, gid, pid: process.pid })
    const socketPath = join(sockDir, 'action.sock')
    const server = await startGitHubBrokerServer({
      actionSocketPath: socketPath,
      adminSocketPath: join(adminDir, 'admin.sock'),
      instanceId: 'broker-v2',
      generation: core.snapshot().generation,
      serverPrivateKey: serverKeys.privateKey,
      clientPublicKey: clientKeys.publicKey,
      clientKeyId: 'client-v2',
      adminPublicKey: adminKeys.publicKey,
      adminKeyId: 'admin-v2',
      core,
      inspectPeerCredentials: peer,
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
      protocolMode: 'action-v2',
    })
    servers.push(server)

    const extCtx = makeCtx()
    let extSvc!: AssistantActionsService
    const extPlugin = await extCtx.plugin({
      name: 'test-ext-pin',
      apply(runtime: Context) {
        extSvc = new AssistantActionsService(runtime, {
          stateRoot: join(root, 'ext-state'),
          externalActionGrants: [pinnedProj],
          broker: {
            mode: 'external-v2',
            actionSocketPath: socketPath,
            brokerId: 'broker-v2',
            brokerPublicKeyPath: brokerPubPath,
            clientKeyId: 'client-v2',
            clientSigningKeyPath: clientPrivPath,
            clientInstanceId: 'host-v2',
            clientGeneration: 1,
            expectedSocketUid: uid,
            expectedSocketGid: gid,
            expectedSocketParentUid: uid,
            expectedSocketParentGid: gid,
            expectedBrokerPeerUid: uid,
            expectedBrokerPeerGid: gid,
            platform: process.platform === 'darwin' ? 'darwin' : 'linux',
            transport: 'posix-uds',
          },
        })
      },
    })

    try {
      const baseInput = {
        grantId: pinnedProj.id,
        domain: 'http' as const,
        operation: 'http.request' as const,
        destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/v1/report' },
        payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/report?mode=read` },
      }

      // 1. Per-request sensitivity escalation & invalid sensitivity fail-closed without consuming lease
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'sens-esc', sensitivity: 'restricted' },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(sensitivity-exceeded\)/)
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, grantId: unconstrainedProj.id, idempotencyKey: 'sens-bogus', sensitivity: 'bogus' as never },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(invalid-input\)/)
      // Anti-downgrade: restricted grant cannot be downgraded via input.sensitivity: 'public'
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, grantId: restrictedProj.id, idempotencyKey: 'sens-downgrade', sensitivity: 'public' },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(sensitivity-exceeded\)/)
      expect(httpHits).toBe(0)

      // 2. HTTP query-string pinning rejects wrong/missing query without consuming lease
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'q-bad-1', payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/report?mode=delete` } },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(destination-mismatch\)/)
      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'q-bad-2', payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/report` } },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(destination-mismatch\)/)
      expect(httpHits).toBe(0)

      // 3. Compliant query + matching sensitivity succeeds once and consumes lease
      const embOk = await embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'q-ok-1', sensitivity: 'internal' },
        new AbortController().signal,
      )
      expect(embOk.status).toBe('succeeded')
      expect(httpHits).toBe(1)
      expect(seenUrls).toEqual(['/v1/report?mode=read'])

      await expect(embSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'q-ok-2' },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/)
      expect(httpHits).toBe(1)

      // 4. external-v2 Host + ExternalBrokerCore enforce the same query pinning & sensitivity across prepare + dispatch
      await expect(extSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'ext-q-bad', payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/report?mode=delete` } },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(destination-mismatch\)/)

      // Direct broker wire request bypassing Host executeAction must also fail WP08 query pinning in ExternalBrokerLedger
      const dummyHello = createActionBrokerServerHello({ instanceId: 'broker-v2', generation: 1, policyEpoch: 1, emergencyEpoch: 0, expiresAt: now + 20_000 }, serverKeys.privateKey)
      const badWireIntent: ActionBrokerRequestIntent = {
        actionId: 'wire-q-bad',
        grantId: pinnedGrant.id,
        grantRevision: 1,
        grantDigest: pinnedGrant.digest,
        domain: 'http',
        owner,
        sessionId: 'sess-pin-1',
        agentId: 'agent-1',
        rootCallId: 'root-pin-1',
        callId: 'call-pin-1',
        operation: 'http.request',
        source: pinnedGrant.source,
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/report' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/report?mode=delete` },
        deadline: now + 20_000,
        budget: { reservationId: 'res-wire-bad', actions: 1, bytes: 1, costMetric: 'http-requests', maxCostUnits: 1 },
        idempotencyKey: 'wire-q-bad',
      }
      const badWireReq = createActionBrokerClientRequest(badWireIntent, dummyHello, baseGrant.client, 'client-v2', clientKeys.privateKey)
      const wireBadRes = await requestActionBroker({
        socketPath,
        serverPublicKey: serverKeys.publicKey,
        clientPrivateKey: clientKeys.privateKey,
        clientKeyId: 'client-v2',
        source: baseGrant.client,
        expectedSocketUid: uid,
        expectedSocketGid: gid,
        expectedSocketMode: 0o600,
        expectedSocketParentUid: uid,
        expectedSocketParentGid: gid,
        expectedSocketParentMode: 0o700,
        inspectPeerCredentials: peer,
        expectedBrokerPeerUid: uid,
        expectedBrokerPeerGid: gid,
        expectedServerInstanceId: 'broker-v2',
        minimumServerGeneration: 1,
      }, { ...badWireIntent, budget: { ...badWireIntent.budget, bytes: brokerPayloadBytes(badWireReq) } })
      expect(wireBadRes.status).toBe('failed')
      expect(httpHits).toBe(1)

      const extOk = await extSvc.executeAction(
        fakeAgent as never,
        { ...baseInput, idempotencyKey: 'ext-q-ok' },
        new AbortController().signal,
      )
      expect(extOk.status).toBe('succeeded')
      expect(httpHits).toBe(2)
      expect(seenUrls).toEqual(['/v1/report?mode=read', '/v1/report?mode=read'])
    } finally {
      await extPlugin.dispose()
      await extCtx.fiber.dispose()
      await embPlugin.dispose()
      await embCtx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('replays settled executeAction idempotently on maxUses: 1 without lease-exhausted and rejects conflicting payloads or distinct keys', async () => {
    const root = await makeTempDir('service-v2-idempotent-')
    const stateRoot = join(root, 'state')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })
    const now = Date.now()

    let serverHits = 0
    const httpServer = createServer((_req, res) => {
      serverHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const owner = {
      principalDigest: createHash('sha256').update('owner-1').digest('hex'),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const grant = createActionGrantProjection({
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'http-idem-once',
      revision: 1,
      domain: 'http',
      clientKeyId: 'host-1',
      owner,
      sessionId: 'sess-idem-1',
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
      lease: { leaseId: 'lease-once', expiresAtMs: now + 60_000, maxUses: 1 },
      policyEpoch: 1,
      emergencyEpoch: 0,
    })

    const fakeAgent = {
      id: 'agent-idem-1',
      session: { id: 'sess-idem-1', header: { cwd: workDir, agentPreset: 'primary' } },
    }
    const ctx = new Context()
    ctx.provide('assistantDelivery', {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-1',
        sessionId: 'sess-idem-1',
        bindingId: 'binding-1',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: workDir, preset: 'primary' },
        principalLineage: {
          principalRecordId: 'owner-1',
          principalVersion: 1,
        },
      }),
    } as never)
    ctx.provide('assistantPolicy', {
      evaluateAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r-allow' }),
      authorizeAgent: () => ({ effect: 'allow', reasonCode: 'rule-allow', ruleId: 'r-allow' }),
    } as never)
    ctx.provide('agents', { get: (id: string) => (id === 'agent-idem-1' ? fakeAgent : undefined) } as never)

    const plugin = await ctx.plugin(AssistantActionsService, {
      stateRoot,
      broker: { mode: 'embedded-compat' },
      actionGrants: [grant],
    })
    const svc = ctx.get('assistantActions')!
    try {
      const firstInput = {
        grantId: grant.id,
        idempotencyKey: 'idem-replay-key-1',
        domain: 'http' as const,
        operation: 'http.request' as const,
        destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/ping' },
        payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/ping` },
      }
      const res1 = await svc.executeAction(fakeAgent as never, firstInput, new AbortController().signal)
      expect(res1.status).toBe('succeeded')
      expect(serverHits).toBe(1)

      // Replay with same idempotencyKey and payload must return cached succeeded result without consuming a second lease use.
      const res2 = await svc.executeAction(fakeAgent as never, firstInput, new AbortController().signal)
      expect(res2).toEqual(res1)
      expect(serverHits).toBe(1)

      // Same idempotencyKey with different payload must fail with idempotency conflict.
      await expect(svc.executeAction(
        fakeAgent as never,
        {
          ...firstInput,
          destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/other' },
          payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/other` },
        },
        new AbortController().signal,
      )).rejects.toThrow(/idempotency conflict/i)

      // Distinct idempotencyKey must fail with lease-exhausted.
      await expect(svc.executeAction(
        fakeAgent as never,
        { ...firstInput, idempotencyKey: 'idem-distinct-key-2' },
        new AbortController().signal,
      )).rejects.toThrow(/WP08 policy rejected \(lease-exhausted\)/)
      expect(serverHits).toBe(1)
    } finally {
      await plugin.dispose()
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('enforces real AssistantPolicyService WP08 constraints in executeAction without charging policy on pre-dispatch local validation failure', async () => {
    const root = await makeTempDir('service-v2-real-policy-wp08-')
    const stateRoot = join(root, 'state')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })
    const now = Date.now()

    let serverHits = 0
    const httpServer = createServer((_req, res) => {
      serverHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('wp08-ok')
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const owner = {
      principalDigest: createHash('sha256').update('owner-wp08').digest('hex'),
      principalRecordId: 'owner-wp08',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-wp08',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const httpGrant = createActionGrantProjection({
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'http-wp08-real',
      revision: 1,
      domain: 'http',
      clientKeyId: 'host-1',
      owner,
      sessionId: 'sess-wp08-real',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 8_192,
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
    const shellGrant = createActionGrantProjection({
      protocol: ACTION_GRANT_PROTOCOL,
      id: 'shell-wp08-real',
      revision: 1,
      domain: 'shell',
      clientKeyId: 'host-1',
      owner,
      sessionId: 'sess-wp08-real',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 8_192,
      maxCostUnits: 10,
      client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      destination: {
        classification: 'shell-command',
        allowedCwds: [workDir],
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        allowNetwork: false,
      },
      allowedOperations: ['shell.exec'],
      credentialId: 'none',
      policyEpoch: 1,
      emergencyEpoch: 0,
    })

    const fakeAgent = {
      id: 'agent-wp08-real',
      session: { id: 'sess-wp08-real', header: { cwd: workDir, agentPreset: 'primary' } },
    }
    const ctx = new Context()
    ctx.provide('assistantDelivery', {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-wp08',
        sessionId: 'sess-wp08-real',
        bindingId: 'binding-wp08',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: workDir, preset: 'primary' },
        principalLineage: { principalRecordId: 'owner-wp08', principalVersion: 1 },
      }),
    } as never)
    ctx.provide('agents', { get: (id: string) => (id === 'agent-wp08-real' ? fakeAgent : undefined) } as never)

    const policyPlugin = await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'wp08-http-rule',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:http-wp08-real' },
          lease: { leaseId: 'policy-http-lease', expiresAtMs: now + 60_000, maxUses: 1 },
          destinations: [`http://127.0.0.1:${port}/v1/allowed*`],
          maxSensitivity: 'internal',
          monetaryCostCapMicros: 1_000,
        },
        {
          id: 'wp08-shell-rule',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:shell-wp08-real' },
          lease: { leaseId: 'policy-shell-lease', expiresAtMs: now + 60_000, maxUses: 1 },
        },
      ],
    })
    const actionsPlugin = await ctx.plugin(AssistantActionsService, {
      stateRoot,
      broker: { mode: 'embedded-compat' },
      actionGrants: [httpGrant, shellGrant],
    })
    const policySvc = ctx.get('assistantPolicy')!
    const actionsSvc = ctx.get('assistantActions')!

    try {
      // 1. Pre-dispatch local HTTP grant validation failure must NOT charge policy lease or cost
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'bad-http-path',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/admin/secret' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/admin/secret` },
          estimatedCostMicros: 500,
        },
        new AbortController().signal,
      )).rejects.toThrow(/HTTP path not permitted by grant/i)
      expect(policySvc.getLeaseState('policy-http-lease')?.uses ?? 0).toBe(0)

      // 2. Pre-dispatch local Shell grant validation failure must NOT charge policy lease
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: shellGrant.id,
          idempotencyKey: 'bad-shell-args',
          domain: 'shell',
          operation: 'shell.exec',
          destination: { classification: 'shell-command', executable: process.execPath, cwd: workDir },
          payload: { executable: process.execPath, args: ['-v'], cwd: workDir, timeoutMs: 1_000 },
        },
        new AbortController().signal,
      )).rejects.toThrow(/allowedArgPrefixes/i)
      expect(policySvc.getLeaseState('policy-shell-lease')?.uses ?? 0).toBe(0)

      // 3. Policy WP08 rejections: disallowed destination, sensitivity exceeded, cost cap exceeded
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'bad-wp08-dest',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/other' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/other` },
          estimatedCostMicros: 500,
        },
        new AbortController().signal,
      )).rejects.toThrow(/external action policy denied/i)
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'bad-wp08-sens',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed` },
          sensitivity: 'restricted',
          estimatedCostMicros: 500,
        },
        new AbortController().signal,
      )).rejects.toThrow(/external action policy denied/i)
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'bad-wp08-cost',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed` },
          estimatedCostMicros: 1_001,
        },
        new AbortController().signal,
      )).rejects.toThrow(/external action policy denied/i)
      expect(policySvc.getLeaseState('policy-http-lease')?.uses ?? 0).toBe(0)

      // 4. Compliant HTTP & Shell requests still have their single-use leases available and succeed
      const okHttp = await actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'ok-wp08-http',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed` },
          estimatedCostMicros: 800,
        },
        new AbortController().signal,
      )
      expect(okHttp.status).toBe('succeeded')
      expect(serverHits).toBe(1)
      expect(policySvc.getLeaseState('policy-http-lease')?.uses).toBe(1)

      const okShell = await actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: shellGrant.id,
          idempotencyKey: 'ok-wp08-shell',
          domain: 'shell',
          operation: 'shell.exec',
          destination: { classification: 'shell-command', executable: process.execPath, cwd: workDir },
          payload: { executable: process.execPath, args: ['-e', 'process.stdout.write("wp08-shell")'], cwd: workDir, timeoutMs: 2_000 },
        },
        new AbortController().signal,
      )
      expect(okShell.status).toBe('succeeded')
      expect(policySvc.getLeaseState('policy-shell-lease')?.uses).toBe(1)

      // 5. Subsequent HTTP request fails because policy-http-lease maxUses=1 is now exhausted
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        {
          grantId: httpGrant.id,
          idempotencyKey: 'ok-wp08-http-2',
          domain: 'http',
          operation: 'http.request',
          destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed' },
          payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed` },
          estimatedCostMicros: 100,
        },
        new AbortController().signal,
      )).rejects.toThrow(/external action policy denied/i)
      expect(serverHits).toBe(1)
    } finally {
      await actionsPlugin.dispose()
      await policyPlugin.dispose()
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('never charges real AssistantPolicyService on external-v2 grant violations or !dispatched failures, while preserving dispatched/postDispatchUnknown charges', async () => {
    const root = await makeTempDir('v2-pr-')
    const keyDir = join(root, 'keys')
    const sockDir = join(root, 's')
    const workDir = join(root, 'work')
    await Promise.all([
      mkdir(keyDir, { mode: 0o700 }),
      mkdir(sockDir, { mode: 0o700 }),
      mkdir(workDir, { mode: 0o700 }),
    ])
    const brokerPubPath = join(keyDir, 'broker.pub')
    const clientPrivPath = join(keyDir, 'client.key')
    await Promise.all([
      writeFile(brokerPubPath, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPrivPath, clientKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])

    let httpHits = 0
    const httpServer = createServer((_req, res) => {
      httpHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as { port: number }).port

    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-wp08-rb').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-wp08-rb',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-rb',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const baseFields = {
      protocol: ACTION_GRANT_PROTOCOL,
      revision: 1,
      clientKeyId: 'client-v2',
      owner,
      sessionId: 'sess-wp08-rb',
      credentialId: 'none',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 8_192,
      maxCostUnits: 10,
      client: { kind: 'assistant-actions-host' as const, instanceId: 'host-v2', generation: 1 },
      source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
    }
    const httpExtGrant = createActionGrantProjection({
      ...baseFields,
      id: 'ext-rb-http',
      domain: 'http',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [port],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/allowed/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 1_024,
      },
      allowedOperations: ['http.request'],
      lease: { leaseId: 'lease-ext-rb', expiresAtMs: now + 60_000, maxUses: 1 },
      monetaryCostCapMicros: 1_000,
    })
    const httpExtGrant2 = createActionGrantProjection({
      ...baseFields,
      id: 'ext-rb-http-2',
      domain: 'http',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [port],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/allowed/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 1_024,
      },
      allowedOperations: ['http.request'],
      lease: { leaseId: 'lease-ext-rb-2', expiresAtMs: now + 60_000, maxUses: 5 },
      monetaryCostCapMicros: 5_000,
    })
    const httpExtGrant3 = createActionGrantProjection({
      ...baseFields,
      id: 'ext-rb-http-3',
      domain: 'http',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['http'],
        allowedHosts: ['127.0.0.1'],
        allowedPorts: [port],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/allowed/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 1_024,
      },
      allowedOperations: ['http.request'],
      lease: { leaseId: 'lease-ext-rb-3', expiresAtMs: now + 60_000, maxUses: 5 },
      monetaryCostCapMicros: 5_000,
    })
    // Remote-only paths verify external-v2 shell validation never fails on missing host-local FS paths
    const remoteShellGrant = createActionGrantProjection({
      ...baseFields,
      id: 'ext-rb-remote-shell',
      domain: 'shell',
      destination: {
        classification: 'shell-command',
        allowedCwds: ['/opt/remote-sandbox/work'],
        allowedCommands: [{ executable: '/opt/remote-sandbox/bin/tool', allowedArgPrefixes: [['--ok']], maxArgs: 2 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        allowNetwork: false,
      },
      allowedOperations: ['shell.exec'],
      lease: { leaseId: 'lease-ext-remote-shell', expiresAtMs: now + 60_000, maxUses: 1 },
    })
    const embDnsGrant = createActionGrantProjection({
      ...baseFields,
      id: 'emb-dns-http',
      domain: 'http',
      destination: {
        classification: 'http-endpoint',
        allowedSchemes: ['https', 'http'],
        allowedHosts: ['nonexistent-ssrf-test.invalid', '127.0.0.1'],
        allowedMethods: ['GET'],
        allowedPathPrefixes: ['/v1/allowed/'],
        allowRedirects: false,
        allowPrivateNetwork: true,
        maxResponseBytes: 1_024,
      },
      allowedOperations: ['http.request'],
      lease: { leaseId: 'lease-emb-dns', expiresAtMs: now + 60_000, maxUses: 1 },
      monetaryCostCapMicros: 1_000,
    })

    const fakeAgent = {
      id: 'agent-wp08-rb',
      session: { id: 'sess-wp08-rb', header: { cwd: workDir, agentPreset: 'primary' } },
    }
    const ctx = new Context()
    ctx.provide('tools' as never, { register: () => () => undefined } as never)
    ctx.provide('agents' as never, { get: (id: string) => (id === 'agent-wp08-rb' ? fakeAgent : undefined) } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-wp08-rb',
        sessionId: 'sess-wp08-rb',
        bindingId: 'binding-rb',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: workDir, preset: 'primary' },
        principalLineage: { principalRecordId: 'owner-wp08-rb', principalVersion: 1 },
      }),
    } as never)
    ctx.provide('credentialsKeychain' as never, {} as never)

    const policyPlugin = await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'rule-ext-rb',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:ext-rb-http' },
          lease: { leaseId: 'lease-ext-rb', expiresAtMs: now + 60_000, maxUses: 1 },
          destinations: [`http://127.0.0.1:${port}/v1/allowed/*`],
          monetaryCostCapMicros: 1_000,
        },
        {
          id: 'rule-ext-rb-2',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:ext-rb-http-2' },
          lease: { leaseId: 'lease-ext-rb-2', expiresAtMs: now + 60_000, maxUses: 1 },
          destinations: [`http://127.0.0.1:${port}/v1/allowed/*`],
          monetaryCostCapMicros: 1_000,
        },
        {
          id: 'rule-ext-rb-3',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:ext-rb-http-3' },
          lease: { leaseId: 'lease-ext-rb-3', expiresAtMs: now + 60_000, maxUses: 1 },
          destinations: [`http://127.0.0.1:${port}/v1/allowed/*`],
          monetaryCostCapMicros: 1_000,
        },
        {
          id: 'rule-ext-remote-shell',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:ext-rb-remote-shell' },
          lease: { leaseId: 'lease-ext-remote-shell', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-emb-dns',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:http:emb-dns-http' },
          lease: { leaseId: 'lease-emb-dns', expiresAtMs: now + 60_000, maxUses: 1 },
          monetaryCostCapMicros: 1_000,
        },
      ],
    })
    const policySvc = ctx.get('assistantPolicy')!

    let externalCalls = 0
    let dispatchMode: 'client-pre-dispatch' | 'broker-not-dispatched' | 'post-dispatch-unknown' | 'broker-dispatched-failed' | 'succeed' = 'succeed'
    let extSvc!: AssistantActionsService
    const extPlugin = await ctx.plugin({
      name: 'test-ext-policy-rb',
      apply(runtime: Context) {
        extSvc = new AssistantActionsService(
          runtime,
          {
            stateRoot: join(root, 'ext-state'),
            externalActionGrants: [httpExtGrant, httpExtGrant2, httpExtGrant3, remoteShellGrant],
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
              platform: process.platform === 'darwin' ? 'darwin' : 'linux',
              transport: 'posix-uds',
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          async (_opts, intent) => {
            externalCalls += 1
            if (dispatchMode === 'client-pre-dispatch') {
              throw new BrokerClientError('socket-invalid', 'not-dispatched', 'socket unavailable')
            }
            if (dispatchMode === 'post-dispatch-unknown') {
              throw new BrokerPostDispatchUnknownError('disconnected', 'eof after write')
            }
            const failed = dispatchMode === 'broker-not-dispatched' || dispatchMode === 'broker-dispatched-failed'
            return {
              protocol: ACTION_BROKER_PROTOCOL,
              type: 'server-response',
              requestId: `req-${intent.actionId}`,
              actionId: intent.actionId,
              instanceId: 'broker-v2',
              generation: 1,
              challenge: Buffer.alloc(32).toString('base64url'),
              requestDigest: 'e'.repeat(64),
              status: failed ? 'failed' : 'succeeded',
              dispatched: dispatchMode === 'broker-not-dispatched' ? false : true,
              result: failed
                ? null
                : intent.domain === 'http'
                  ? {
                      domain: 'http',
                      operation: 'http.request',
                      statusCode: 200,
                      responseHeaders: {},
                      body: '{"ok":true}',
                      bodySha256: 'd'.repeat(64),
                      truncated: false,
                      untrusted: true,
                    }
                  : {
                      domain: 'shell',
                      operation: 'shell.exec',
                      exitCode: 0,
                      stdout: 'remote-ok',
                      stderr: '',
                      stdoutSha256: 'd'.repeat(64),
                      stderrSha256: 'd'.repeat(64),
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

    const embCtx = new Context()
    embCtx.provide('tools' as never, { register: () => () => undefined } as never)
    embCtx.provide('agents' as never, { get: (id: string) => (id === 'agent-wp08-rb' ? fakeAgent : undefined) } as never)
    embCtx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-wp08-rb',
        sessionId: 'sess-wp08-rb',
        bindingId: 'binding-rb',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: workDir, preset: 'primary' },
        principalLineage: { principalRecordId: 'owner-wp08-rb', principalVersion: 1 },
      }),
    } as never)
    embCtx.provide('assistantPolicy' as never, policySvc as never)
    embCtx.provide('credentialsKeychain' as never, {} as never)
    const embPlugin = await embCtx.plugin(AssistantActionsService, {
      stateRoot: join(root, 'emb-state'),
      broker: { mode: 'embedded-compat' },
      actionGrants: [embDnsGrant],
    })
    const embSvc = embCtx.get('assistantActions')!

    try {
      // 1a. external-v2 local HTTP grant violation fails pre-auth: 0 broker calls, 0 policy charges
      await expect(extSvc.executeAction(fakeAgent as never, {
        grantId: 'ext-rb-http',
        idempotencyKey: 'ext-forbidden-path',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/forbidden' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/forbidden` },
        estimatedCostMicros: 900,
      }, new AbortController().signal)).rejects.toThrow(/HTTP path not permitted by grant/i)
      expect(externalCalls).toBe(0)
      expect(policySvc.getLeaseState('lease-ext-rb')?.uses ?? 0).toBe(0)

      // 1b. external-v2 shell disallowed arg fails pre-auth without touching local FS, while valid remote path succeeds
      await expect(extSvc.executeAction(fakeAgent as never, {
        grantId: 'ext-rb-remote-shell',
        idempotencyKey: 'ext-shell-bad-arg',
        domain: 'shell',
        operation: 'shell.exec',
        destination: { classification: 'shell-command', executable: '/opt/remote-sandbox/bin/tool', cwd: '/opt/remote-sandbox/work' },
        payload: { executable: '/opt/remote-sandbox/bin/tool', args: ['--bad'], cwd: '/opt/remote-sandbox/work', timeoutMs: 1_000 },
      }, new AbortController().signal)).rejects.toThrow(/allowedArgPrefixes/i)
      expect(externalCalls).toBe(0)
      expect(policySvc.getLeaseState('lease-ext-remote-shell')?.uses ?? 0).toBe(0)

      const remoteShellOk = await extSvc.executeAction(fakeAgent as never, {
        grantId: 'ext-rb-remote-shell',
        idempotencyKey: 'ext-shell-good',
        domain: 'shell',
        operation: 'shell.exec',
        destination: { classification: 'shell-command', executable: '/opt/remote-sandbox/bin/tool', cwd: '/opt/remote-sandbox/work' },
        payload: { executable: '/opt/remote-sandbox/bin/tool', args: ['--ok'], cwd: '/opt/remote-sandbox/work', timeoutMs: 1_000 },
      }, new AbortController().signal)
      expect(remoteShellOk).toMatchObject({ status: 'succeeded', result: { stdout: 'remote-ok' } })
      expect(externalCalls).toBe(1)
      expect(policySvc.getLeaseState('lease-ext-remote-shell')?.uses).toBe(1)

      // 2. external-v2 BrokerClientError(not-dispatched) rolls back policy lease & cost -> retry with SAME key succeeds
      const okReq = {
        grantId: 'ext-rb-http',
        idempotencyKey: 'ext-retry-same-key',
        domain: 'http' as const,
        operation: 'http.request' as const,
        destination: { classification: 'http-endpoint' as const, scheme: 'http' as const, host: '127.0.0.1', port, path: '/v1/allowed/ok' },
        payload: { method: 'GET' as const, url: `http://127.0.0.1:${port}/v1/allowed/ok` },
        estimatedCostMicros: 900,
      }
      dispatchMode = 'client-pre-dispatch'
      await expect(extSvc.executeAction(fakeAgent as never, okReq, new AbortController().signal))
        .rejects.toMatchObject({ postDispatchUnknown: false, code: 'socket-invalid' })
      expect(policySvc.getLeaseState('lease-ext-rb')?.uses ?? 0).toBe(0)

      // External broker { status: 'failed', dispatched: false } also rolls back policy lease & cost
      dispatchMode = 'broker-not-dispatched'
      const failedPre = await extSvc.executeAction(fakeAgent as never, okReq, new AbortController().signal)
      expect(failedPre).toMatchObject({ status: 'failed', reason: 'external-broker-transport-failed' })
      expect(policySvc.getLeaseState('lease-ext-rb')?.uses ?? 0).toBe(0)

      // Retry with the SAME idempotencyKey now succeeds with full 1_000 cost cap & 1 lease use intact
      dispatchMode = 'succeed'
      const retriedSame = await extSvc.executeAction(fakeAgent as never, okReq, new AbortController().signal)
      expect(retriedSame.status).toBe('succeeded')
      expect(policySvc.getLeaseState('lease-ext-rb')?.uses).toBe(1)

      // 3. postDispatchUnknown: true does NOT roll back policy lease or cost
      dispatchMode = 'post-dispatch-unknown'
      await expect(extSvc.executeAction(fakeAgent as never, {
        ...okReq,
        grantId: 'ext-rb-http-2',
        idempotencyKey: 'ext-unknown-key',
        estimatedCostMicros: 900,
      }, new AbortController().signal)).rejects.toMatchObject({ postDispatchUnknown: true })
      expect(policySvc.getLeaseState('lease-ext-rb-2')?.uses).toBe(1)
      dispatchMode = 'succeed'
      await expect(extSvc.executeAction(fakeAgent as never, {
        ...okReq,
        grantId: 'ext-rb-http-2',
        idempotencyKey: 'ext-unknown-retry',
        estimatedCostMicros: 900,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)

      // 3b. broker { status: 'failed', dispatched: true } also does NOT roll back
      dispatchMode = 'broker-dispatched-failed'
      const dispatchedFail = await extSvc.executeAction(fakeAgent as never, {
        ...okReq,
        grantId: 'ext-rb-http-3',
        idempotencyKey: 'ext-dispatched-fail',
        estimatedCostMicros: 900,
      }, new AbortController().signal)
      expect(dispatchedFail).toMatchObject({ status: 'failed', reason: 'external-broker-transport-failed' })
      expect(policySvc.getLeaseState('lease-ext-rb-3')?.uses).toBe(1)
      dispatchMode = 'succeed'
      await expect(extSvc.executeAction(fakeAgent as never, {
        ...okReq,
        grantId: 'ext-rb-http-3',
        idempotencyKey: 'ext-dispatched-fail-retry',
        estimatedCostMicros: 900,
      }, new AbortController().signal)).rejects.toThrow(/external action policy denied/i)

      // 4. embedded-compat DNS pre-dispatch failure (!dispatched) preserves lease & cost for retry
      await expect(embSvc.executeAction(fakeAgent as never, {
        grantId: 'emb-dns-http',
        idempotencyKey: 'emb-dns-fail',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'https', host: 'nonexistent-ssrf-test.invalid', path: '/v1/allowed/ok' },
        payload: { method: 'GET', url: 'https://nonexistent-ssrf-test.invalid/v1/allowed/ok' },
        estimatedCostMicros: 900,
      }, new AbortController().signal)).rejects.toThrow(/DNS resolution failed/i)
      expect(policySvc.getLeaseState('lease-emb-dns')?.uses ?? 0).toBe(0)

      const embOk = await embSvc.executeAction(fakeAgent as never, {
        grantId: 'emb-dns-http',
        idempotencyKey: 'emb-dns-recover',
        domain: 'http',
        operation: 'http.request',
        destination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port, path: '/v1/allowed/ok' },
        payload: { method: 'GET', url: `http://127.0.0.1:${port}/v1/allowed/ok` },
        estimatedCostMicros: 900,
      }, new AbortController().signal)
      expect(embOk.status).toBe('succeeded')
      expect(httpHits).toBe(1)
      expect(policySvc.getLeaseState('lease-emb-dns')?.uses).toBe(1)
    } finally {
      await embPlugin.dispose()
      await embCtx.fiber.dispose()
      await extPlugin.dispose()
      await policyPlugin.dispose()
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })

  it('coalesces concurrent identical-key shell executeAction calls before validateShellAgainstGrant and preserves policy lease on concurrent pre-dispatch failures', async () => {
    const root = await makeTempDir('service-v2-shell-race-')
    const workDir = join(root, 'work')
    await mkdir(workDir, { mode: 0o700 })
    const now = Date.now()
    const realDigest = createHash('sha256').update('owner-shell-race').digest('hex')
    const owner = {
      principalDigest: realDigest,
      principalRecordId: 'owner-shell-race',
      principalVersion: 1,
      workspace: workDir,
      preset: 'primary',
      bindingId: 'binding-sr',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const baseFields = {
      protocol: ACTION_GRANT_PROTOCOL,
      revision: 1,
      domain: 'shell' as const,
      clientKeyId: 'host-1',
      owner,
      sessionId: 'sess-shell-race',
      destination: {
        classification: 'shell-command' as const,
        allowedCwds: [workDir],
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 3 }],
        allowedEnvKeys: [],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 2_048,
        maxStderrBytes: 2_048,
        allowNetwork: false as const,
      },
      credentialId: 'none',
      expiresAt: now + 60_000,
      maxActions: 10,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 10,
      allowedOperations: ['shell.exec'] as const,
      client: { kind: 'assistant-actions-host' as const, instanceId: 'host-1', generation: 1 },
      source: { classification: 'internal' as const, provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
    }

    // 1. Grant with grant.lease.maxUses = 1
    const grantLeaseGrant = createActionGrantProjection({
      ...baseFields,
      id: 'shell-race-grant-lease',
      lease: { leaseId: 'lease-sr-grant', expiresAtMs: now + 60_000, maxUses: 1 },
    })
    // 2. Grant without grant.lease (enforced solely by AssistantPolicyService lease.maxUses = 1)
    const policyLeaseGrant = createActionGrantProjection({
      ...baseFields,
      id: 'shell-race-policy-lease',
    })
    // 3. Grant for concurrent pre-dispatch ShellGuardError rollback test
    const preFailGrant = createActionGrantProjection({
      ...baseFields,
      id: 'shell-race-prefail',
    })
    // 4. Grant for concurrent conflicting requestDigest test
    const conflictGrant = createActionGrantProjection({
      ...baseFields,
      id: 'shell-race-conflict',
    })

    const fakeAgent = {
      id: 'agent-shell-race',
      session: { id: 'sess-shell-race', header: { cwd: workDir, agentPreset: 'primary' } },
    }
    const ctx = new Context()
    ctx.provide('tools' as never, { register: () => () => undefined } as never)
    ctx.provide('agents' as never, { get: (id: string) => (id === 'agent-shell-race' ? fakeAgent : undefined) } as never)
    ctx.provide('assistantDelivery' as never, {
      preferencePrincipalForAgent: () => ({
        principalId: 'owner-shell-race',
        sessionId: 'sess-shell-race',
        bindingId: 'binding-sr',
        bindingVersion: 1,
        bindingGeneration: 1,
        scope: { workspace: workDir, preset: 'primary' },
        principalLineage: { principalRecordId: 'owner-shell-race', principalVersion: 1 },
      }),
    } as never)
    ctx.provide('credentialsKeychain' as never, {} as never)

    const policyPlugin = await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
      rules: [
        {
          id: 'rule-sr-grant',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:shell-race-grant-lease' },
          lease: { leaseId: 'lease-sr-grant', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-sr-policy',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:shell-race-policy-lease' },
          lease: { leaseId: 'lease-sr-policy', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-sr-prefail',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:shell-race-prefail' },
          lease: { leaseId: 'lease-sr-prefail', expiresAtMs: now + 60_000, maxUses: 1 },
        },
        {
          id: 'rule-sr-conflict',
          effect: 'allow',
          subject: { kind: 'agent', id: 'primary', workspace: workDir },
          actions: ['execute'],
          resource: { kind: 'tool', id: 'action:shell:shell-race-conflict' },
          lease: { leaseId: 'lease-sr-conflict', expiresAtMs: now + 60_000, maxUses: 1 },
        },
      ],
    })
    const policySvc = ctx.get('assistantPolicy')!
    const actionsPlugin = await ctx.plugin(AssistantActionsService, {
      stateRoot: join(root, 'actions-state'),
      broker: { mode: 'embedded-compat' },
      actionGrants: [grantLeaseGrant, policyLeaseGrant, preFailGrant, conflictGrant],
    })
    const actionsSvc = ctx.get('assistantActions')!

    const countExecs = async (fileName: string): Promise<number> => {
      try {
        const raw = await readFile(join(workDir, fileName), 'utf8')
        return raw.split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }
    const makeShellReq = (grantId: string, idempotencyKey: string, logName: string, extraArg?: string) => ({
      grantId,
      idempotencyKey,
      domain: 'shell' as const,
      operation: 'shell.exec' as const,
      destination: { classification: 'shell-command' as const, executable: process.execPath, cwd: workDir },
      payload: {
        executable: process.execPath,
        args: [
          '-e',
          `require("node:fs").appendFileSync(${JSON.stringify(logName)},"1\\n");process.stdout.write("race-ok")`,
          ...(extraArg === undefined ? [] : [extraArg]),
        ],
        cwd: workDir,
        timeoutMs: 3_000,
      },
    })

    try {
      // A. Concurrent identical-key valid shell calls with grant.lease.maxUses = 1
      const reqGrant = makeShellReq('shell-race-grant-lease', 'idem-sr-grant-1', 'exec-grant.log')
      const [g1, g2] = await Promise.all([
        actionsSvc.executeAction(fakeAgent as never, reqGrant, new AbortController().signal),
        actionsSvc.executeAction(fakeAgent as never, reqGrant, new AbortController().signal),
      ])
      expect(g1.status).toBe('succeeded')
      expect(g2).toEqual(g1)
      expect(g1).not.toBe(g2)
      expect(await countExecs('exec-grant.log')).toBe(1)
      expect(policySvc.getLeaseState('lease-sr-grant')?.uses).toBe(1)
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        makeShellReq('shell-race-grant-lease', 'idem-sr-grant-2', 'exec-grant.log'),
        new AbortController().signal,
      )).rejects.toThrow(/lease-exhausted|policy denied/i)
      expect(await countExecs('exec-grant.log')).toBe(1)

      // B. Concurrent identical-key valid shell calls with policy.lease.maxUses = 1 (no grant.lease)
      const reqPolicy = makeShellReq('shell-race-policy-lease', 'idem-sr-policy-1', 'exec-policy.log')
      const [p1, p2] = await Promise.all([
        actionsSvc.executeAction(fakeAgent as never, reqPolicy, new AbortController().signal),
        actionsSvc.executeAction(fakeAgent as never, reqPolicy, new AbortController().signal),
      ])
      expect(p1.status).toBe('succeeded')
      expect(p2).toEqual(p1)
      expect(await countExecs('exec-policy.log')).toBe(1)
      expect(policySvc.getLeaseState('lease-sr-policy')?.uses).toBe(1)
      await expect(actionsSvc.executeAction(
        fakeAgent as never,
        makeShellReq('shell-race-policy-lease', 'idem-sr-policy-2', 'exec-policy.log'),
        new AbortController().signal,
      )).rejects.toThrow(/policy denied/i)
      expect(await countExecs('exec-policy.log')).toBe(1)

      // C. Concurrent identical-key pre-dispatch ShellGuardError failures leave policy lease uses = 0
      const reqFail = makeShellReq('shell-race-prefail', 'idem-sr-prefail-1', 'exec-prefail.log', 'ghp_12345678901234567890')
      const failRace = await Promise.allSettled([
        actionsSvc.executeAction(fakeAgent as never, reqFail, new AbortController().signal),
        actionsSvc.executeAction(fakeAgent as never, reqFail, new AbortController().signal),
      ])
      expect(failRace[0].status).toBe('rejected')
      expect(failRace[1].status).toBe('rejected')
      expect((failRace[0] as PromiseRejectedResult).reason).toMatchObject({ name: 'ShellGuardError', dispatched: false })
      expect((failRace[1] as PromiseRejectedResult).reason).toMatchObject({ name: 'ShellGuardError', dispatched: false })
      expect(await countExecs('exec-prefail.log')).toBe(0)
      expect(policySvc.getLeaseState('lease-sr-prefail')?.uses ?? 0).toBe(0)

      // Subsequent compliant call on the same lease succeeds
      const recovered = await actionsSvc.executeAction(
        fakeAgent as never,
        makeShellReq('shell-race-prefail', 'idem-sr-prefail-2', 'exec-prefail.log'),
        new AbortController().signal,
      )
      expect(recovered.status).toBe('succeeded')
      expect(await countExecs('exec-prefail.log')).toBe(1)
      expect(policySvc.getLeaseState('lease-sr-prefail')?.uses).toBe(1)

      // D. Concurrent identical-key mismatched requestDigest still rejects with conflict
      const conflictRace = await Promise.allSettled([
        actionsSvc.executeAction(
          fakeAgent as never,
          makeShellReq('shell-race-conflict', 'idem-sr-conflict-1', 'exec-conflict.log', 'arg-a'),
          new AbortController().signal,
        ),
        actionsSvc.executeAction(
          fakeAgent as never,
          makeShellReq('shell-race-conflict', 'idem-sr-conflict-1', 'exec-conflict.log', 'arg-b'),
          new AbortController().signal,
        ),
      ])
      expect(conflictRace[0].status).toBe('fulfilled')
      expect(conflictRace[1].status).toBe('rejected')
      expect((conflictRace[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
      expect(((conflictRace[1] as PromiseRejectedResult).reason as Error).message).toMatch(/action idempotency conflict/i)
      expect(await countExecs('exec-conflict.log')).toBe(1)
      expect(policySvc.getLeaseState('lease-sr-conflict')?.uses).toBe(1)
    } finally {
      await actionsPlugin.dispose()
      await policyPlugin.dispose()
      await ctx.fiber.dispose()
    }
  })
})
