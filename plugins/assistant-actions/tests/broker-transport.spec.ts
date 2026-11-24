import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createConnection, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestGitHubBroker } from '../src/broker-client.ts'
import { brokerPayloadBytes } from '../src/broker-ledger.ts'
import { createBrokerClientRequest, createBrokerServerHello, type BrokerRequestIntent } from '../src/broker-protocol.ts'
import { startGitHubBrokerServer, type BrokerPeerCredentialInspector, type GitHubBrokerCorePort, type GitHubBrokerServer } from '../src/broker-server.ts'
import {
  createBrokerTransportAdapter,
  createWindowsPipeTransportAdapter,
  inspectPlatformPeerCredentials,
  matchesPeerIdentity,
  platformPeerCredentialsAvailable,
  resolveBrokerPlatform,
  resolveBrokerTransportKind,
} from '../src/broker-transport.ts'

const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0
const serverKeys = generateKeyPairSync('ed25519')
const clientKeys = generateKeyPairSync('ed25519')
const adminKeys = generateKeyPairSync('ed25519')
const roots: string[] = []
const servers: GitHubBrokerServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Broker Transport Abstraction (broker-transport.ts)', () => {
  it('resolves platform, transport kind, peer inspector, and peer identity matching', () => {
    expect(resolveBrokerPlatform('auto', 'linux')).toBe('linux')
    expect(resolveBrokerPlatform('auto', 'darwin')).toBe('darwin')
    expect(resolveBrokerPlatform('auto', 'win32')).toBe('win32')
    expect(() => resolveBrokerPlatform('auto', 'freebsd')).toThrow()

    expect(resolveBrokerTransportKind('linux', 'auto', 'linux')).toBe('posix-uds')
    expect(resolveBrokerTransportKind('darwin', 'auto', 'darwin')).toBe('posix-uds')
    expect(resolveBrokerTransportKind('win32', 'auto', 'win32')).toBe('windows-pipe')

    expect(platformPeerCredentialsAvailable('linux', { linuxAvailable: () => true })).toBe(true)
    expect(platformPeerCredentialsAvailable('darwin', { macosAvailable: () => true })).toBe(true)
    expect(platformPeerCredentialsAvailable('win32', { windowsAvailable: () => true })).toBe(true)

    const macInspector: BrokerPeerCredentialInspector = () => ({ uid: 501, gid: 20, pid: 100 })
    const winInspector: BrokerPeerCredentialInspector = () => ({ uid: 0, gid: 0, pid: 200, sid: 'S-1-5-21-1000' })
    expect(inspectPlatformPeerCredentials('darwin', 'client', { macosInspector: macInspector })).toBe(macInspector)
    expect(inspectPlatformPeerCredentials('win32', 'server', { windowsServerInspector: winInspector })).toBe(winInspector)

    expect(matchesPeerIdentity({ uid: 1000, gid: 1000, pid: 10 }, { uid: 1000, gid: 1000 }, 'posix-uds')).toBe(true)
    expect(matchesPeerIdentity({ uid: 1000, gid: 1000, pid: 10 }, { uid: 1001, gid: 1000 }, 'posix-uds')).toBe(false)
    expect(matchesPeerIdentity({ uid: 0, gid: 0, pid: 200, sid: 'S-1-5-21-1000' }, { sid: 'S-1-5-21-1000' }, 'windows-pipe')).toBe(true)
    expect(matchesPeerIdentity({ uid: 0, gid: 0, pid: 200, sid: 'S-1-5-21-9999' }, { sid: 'S-1-5-21-1000' }, 'windows-pipe')).toBe(false)
    expect(matchesPeerIdentity({ uid: 0, gid: 0, pid: 200 }, { sid: 'S-1-5-21-1000' }, 'windows-pipe')).toBe(false)
  })

  it('validates Windows named pipe endpoints and runs full server-client handshake over simulated windows-pipe & darwin adapters', async () => {
    const isWin = process.platform === 'win32'
    const actionPipePath = isWin ? `\\\\.\\pipe\\dsh-sim-action-${process.pid}-${randomUUID()}` : '\\\\.\\pipe\\dsh-sim-action'
    const adminPipePath = isWin ? `\\\\.\\pipe\\dsh-sim-admin-${process.pid}-${randomUUID()}` : '\\\\.\\pipe\\dsh-sim-admin'
    const winPeer: BrokerPeerCredentialInspector = () => ({ uid: 0, gid: 0, pid: process.pid, sid: 'S-1-5-21-1000' })

    let serverAdapter: ReturnType<typeof createWindowsPipeTransportAdapter>
    let clientAdapter: ReturnType<typeof createWindowsPipeTransportAdapter>
    if (isWin) {
      serverAdapter = createWindowsPipeTransportAdapter(winPeer)
      clientAdapter = createWindowsPipeTransportAdapter(winPeer)
    } else {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'transport-sim-')))
      roots.push(dir)
      const sockDir = join(dir, 'sock')
      await mkdir(sockDir, { mode: 0o700 })
      await chmod(sockDir, 0o700)

      const pipeToSock = new Map<string, string>([
        [actionPipePath, join(sockDir, 'sim-action.sock')],
        [adminPipePath, join(sockDir, 'sim-admin.sock')],
      ])
      const listenSim = async (server: Server, pipePath: string): Promise<void> => {
        const sock = pipeToSock.get(pipePath)!
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.once('listening', resolve)
          server.listen(sock)
        })
      }
      const connectSim = (pipePath: string): Socket => createConnection({ path: pipeToSock.get(pipePath)! })

      serverAdapter = createWindowsPipeTransportAdapter(winPeer, { listen: listenSim, connect: connectSim })
      clientAdapter = createWindowsPipeTransportAdapter(winPeer, { listen: listenSim, connect: connectSim })
    }

    // Invalid UNC/traversal pipe rejected
    expect(() => serverAdapter.validateEndpointPath('\\\\remote\\pipe\\x')).toThrow(/named pipe/)

    const core: GitHubBrokerCorePort = {
      snapshot: () => ({ generation: 1, policyEpoch: 1, emergencyEpoch: 0 }),
      execute: async request => ({
        status: 'succeeded',
        dispatched: true,
        result: {
          operation: 'inspect',
          repository: request.destination.repository,
          branch: request.destination.branch,
          kind: 'repository',
          observed: { full_name: request.destination.repository, untrusted: true },
          observedDigest: '3b485ed503a920e001d328316367fc32da623ed2d32404282c669ce6ae40d3cd',
        },
        error: null,
        completedAt: Date.now(),
      }),
      admin: async () => ({
        status: 'succeeded',
        state: { admission: 'accepting', generation: 1, controlVersion: 0, activeRequests: 0, revocationEpoch: 0 },
        error: null,
        completedAt: Date.now(),
      }),
      beginDrain: () => undefined,
      drain: async () => undefined,
      close: () => undefined,
    }

    const server = await startGitHubBrokerServer({
      actionSocketPath: actionPipePath,
      adminSocketPath: adminPipePath,
      instanceId: 'broker-win-sim',
      generation: 1,
      serverPrivateKey: serverKeys.privateKey,
      clientPublicKey: clientKeys.publicKey,
      clientKeyId: 'client-win',
      adminPublicKey: adminKeys.publicKey,
      adminKeyId: 'admin-win',
      core,
      inspectPeerCredentials: winPeer,
      expectedClientPeerUid: 0,
      expectedClientPeerGid: 0,
      expectedAdminPeerUid: 0,
      expectedAdminPeerGid: 0,
      expectedClientPeerSid: 'S-1-5-21-1000',
      expectedAdminPeerSid: 'S-1-5-21-1000',
      expectedActionSocketUid: 0,
      expectedActionSocketGid: 0,
      expectedActionParentMode: 0o700,
      expectedActionSocketMode: 0o600,
      expectedAdminSocketUid: 0,
      expectedAdminSocketGid: 0,
      expectedAdminParentMode: 0o700,
      expectedAdminSocketMode: 0o600,
      transport: serverAdapter,
    })
    servers.push(server)

    const now = Date.now()
    const intentBase: BrokerRequestIntent = {
      actionId: 'win-act-1',
      grantId: 'g1',
      grantRevision: 1,
      grantDigest: '1'.repeat(64),
      owner: { principalDigest: '2'.repeat(64), principalRecordId: 'p1', principalVersion: 1, workspace: '/ws', preset: 'default', bindingId: 'b1', bindingVersion: 1, bindingGeneration: 1 },
      sessionId: 's1',
      agentId: 'a1',
      rootCallId: 'r1',
      callId: 'c1',
      operation: 'inspect',
      source: { classification: 'internal', provenanceDigest: '3'.repeat(64) },
      destination: { classification: 'github-repository', repository: 'owner/repo', branch: 'main' },
      payload: { kind: 'repository' },
      deadline: now + 10_000,
      budget: { reservationId: 'res1', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 },
    }
    const hello = createBrokerServerHello({ instanceId: 'broker-win-sim', generation: 1, policyEpoch: 1, emergencyEpoch: 0, expiresAt: now + 10_000 }, serverKeys.privateKey)
    const sampleReq = createBrokerClientRequest(intentBase, hello, { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 }, 'client-win', clientKeys.privateKey)
    const intent = { ...intentBase, budget: { ...intentBase.budget, bytes: brokerPayloadBytes(sampleReq) } }

    const res = await requestGitHubBroker({
      socketPath: actionPipePath,
      serverPublicKey: serverKeys.publicKey,
      clientPrivateKey: clientKeys.privateKey,
      clientKeyId: 'client-win',
      source: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
      expectedBrokerPeerUid: 0,
      expectedBrokerPeerGid: 0,
      expectedBrokerPeerSid: 'S-1-5-21-1000',
      expectedServerInstanceId: 'broker-win-sim',
      minimumServerGeneration: 1,
      transport: clientAdapter,
    }, intent)
    expect(res.status).toBe('succeeded')

    // Verify darwin adapter constructs cleanly
    const darwinAdapter = createBrokerTransportAdapter({ platform: 'darwin', inspectPeer: () => ({ uid, gid, pid: process.pid }), runtimePlatform: 'darwin' })
    expect(darwinAdapter.kind).toBe('posix-uds')
    expect(darwinAdapter.platform).toBe('darwin')
  })
})
