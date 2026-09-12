import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestGitHubBroker, requestGitHubBrokerAdmin } from '../src/broker-client.js'
import {
  BrokerFrameDecoder, GITHUB_BROKER_RESPONSE_MAX_BYTES, createBrokerClientRequest, encodeBrokerFrame, verifyBrokerServerHello,
  type BrokerAdminRequest, type BrokerAdminResponseUnsigned, type BrokerClientRequest, type BrokerRequestIntent, type BrokerServerResponseUnsigned,
} from '../src/broker-protocol.js'
import { GitHubBrokerServerError, startGitHubBrokerServer, type BrokerPeerCredentialInspector, type GitHubBrokerCorePort, type GitHubBrokerServer } from '../src/broker-server.js'
import { loadBrokerCliConfig, runBrokerCli } from '../src/broker-cli.js'
import { linuxPeerCredentialsAvailable } from '../src/broker-peer-linux.js'
import { ExternalBrokerCore } from '../src/broker-core.js'
import { withBrokerGrantDigest } from '../src/broker-ledger.js'
import { writeFile } from 'node:fs/promises'

const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0
const brokerCliEntrypoint = fileURLToPath(new URL('../lib/broker-cli.js', import.meta.url))
const serverKeys = generateKeyPairSync('ed25519'), clientKeys = generateKeyPairSync('ed25519'), adminKeys = generateKeyPairSync('ed25519')
const roots: string[] = [], servers: GitHubBrokerServer[] = [], replacements: Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined)
  for (const server of replacements.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function privateSocketPath(mode = 0o700): Promise<string> {
  const outer = await mkdtemp(join(tmpdir(), 'actions-broker-server-'))
  const root = join(outer, 'runtime')
  await mkdir(root, { mode }); await chmod(root, mode)
  roots.push(outer)
  return join(root, 'broker.sock')
}

function response(request: BrokerClientRequest): Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'> {
  return { status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'repository', observed: { full_name: request.destination.repository, untrusted: true }, observedDigest: '3b485ed503a920e001d328316367fc32da623ed2d32404282c669ce6ae40d3cd' }, error: null, completedAt: Date.now() }
}

function core(overrides: Partial<GitHubBrokerCorePort> = {}): GitHubBrokerCorePort {
  return {
    snapshot: () => ({ generation: 7, policyEpoch: 3, emergencyEpoch: 4 }),
    execute: async request => response(request),
    admin: async request => ({ status: 'succeeded', state: { admission: request.operation === 'stop' ? 'stopped' : 'accepting', generation: 7, controlVersion: 9, activeRequests: 0, revocationEpoch: 2 }, error: null, completedAt: Date.now() }),
    beginDrain: () => undefined, drain: async () => undefined, close: () => undefined, ...overrides,
  }
}

const trustedPeer: BrokerPeerCredentialInspector = () => ({ uid, gid, pid: process.pid })
async function start(options: { path?: string; generation?: number; core?: GitHubBrokerCorePort; peer?: BrokerPeerCredentialInspector; clientPeer?: { uid: number; gid: number }; adminPeer?: { uid: number; gid: number }; clientPublicKey?: KeyObject; adminPublicKey?: KeyObject; clientKeyId?: string; adminKeyId?: string; firstByteTimeoutMs?: number; frameTimeoutMs?: number; totalTimeoutMs?: number; maxConcurrentRequests?: number; maxActionConnections?: number; maxAdminConnections?: number; parentMode?: number; socketMode?: number } = {}): Promise<GitHubBrokerServer> {
  const actionSocketPath = options.path ?? await privateSocketPath(), adminDirectory = join(dirname(dirname(actionSocketPath)), 'admin-runtime')
  await mkdir(adminDirectory, { recursive: true, mode: 0o700 }); await chmod(adminDirectory, 0o700)
  const adminSocketPath = join(adminDirectory, 'broker-admin.sock')
  const server = await startGitHubBrokerServer({
    actionSocketPath, adminSocketPath, instanceId: 'broker-fixture', generation: options.generation ?? 7, serverPrivateKey: serverKeys.privateKey, clientPublicKey: options.clientPublicKey ?? clientKeys.publicKey, clientKeyId: options.clientKeyId ?? 'client-fixture',
    adminPublicKey: options.adminPublicKey ?? adminKeys.publicKey, adminKeyId: options.adminKeyId ?? 'admin-fixture', core: options.core ?? core(), inspectPeerCredentials: options.peer ?? trustedPeer,
    expectedClientPeerUid: options.clientPeer?.uid ?? uid, expectedClientPeerGid: options.clientPeer?.gid ?? gid, expectedAdminPeerUid: options.adminPeer?.uid ?? uid, expectedAdminPeerGid: options.adminPeer?.gid ?? gid,
    expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: options.parentMode ?? 0o700, expectedActionSocketMode: options.socketMode ?? 0o600,
    expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600, firstByteTimeoutMs: options.firstByteTimeoutMs ?? 100,
    frameTimeoutMs: options.frameTimeoutMs ?? 200, totalTimeoutMs: options.totalTimeoutMs ?? 1_000, drainTimeoutMs: 200,
    maxActionConnections: options.maxActionConnections ?? 32, maxAdminConnections: options.maxAdminConnections ?? 4,
    ...(options.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: options.maxConcurrentRequests }),
  })
  servers.push(server)
  return server
}

function intent(): BrokerRequestIntent {
  return {
    actionId: 'action-1', grantId: 'grant-1', grantRevision: 1, grantDigest: '1'.repeat(64),
    owner: { principalDigest: '2'.repeat(64), principalRecordId: 'principal-1', principalVersion: 1, workspace: '/workspace', preset: 'default', bindingId: 'binding-1', bindingVersion: 1, bindingGeneration: 1 },
    sessionId: 'session-1', agentId: 'agent-1', rootCallId: 'root-1', callId: 'call-1', operation: 'inspect',
    source: { classification: 'internal', provenanceDigest: '3'.repeat(64) }, destination: { classification: 'github-repository', repository: 'owner/repo', branch: 'main' },
    payload: { kind: 'repository' }, deadline: Date.now() + 5_000, budget: { reservationId: 'reservation-1', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 },
  }
}

function connectionOptions(socketPath: string) {
  return { socketPath, serverPublicKey: serverKeys.publicKey, expectedSocketUid: uid, expectedSocketGid: gid, expectedSocketMode: 0o600, expectedSocketParentUid: uid, expectedSocketParentGid: gid, expectedSocketParentMode: 0o700, inspectPeerCredentials: trustedPeer, expectedBrokerPeerUid: uid, expectedBrokerPeerGid: gid, expectedServerInstanceId: 'broker-fixture', minimumServerGeneration: 7, timeoutMs: 1_000 }
}

function actionOptions(socketPath: string) {
  return { ...connectionOptions(socketPath), clientPrivateKey: clientKeys.privateKey, clientKeyId: 'client-fixture', source: { kind: 'assistant-actions-host' as const, instanceId: 'host-fixture', generation: 2 } }
}

async function connect(path: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => { const socket = createConnection({ path }); socket.once('connect', () => resolve(socket)); socket.once('error', reject) })
}

async function nextFrame(socket: Socket): Promise<unknown> {
  const decoder = new BrokerFrameDecoder(GITHUB_BROKER_RESPONSE_MAX_BYTES, 1)
  return await new Promise((resolve, reject) => {
    socket.on('data', chunk => { try { const values = decoder.push(chunk); if (values[0] !== undefined) resolve(values[0]) } catch (error) { reject(error) } })
    socket.once('error', reject); socket.once('end', () => reject(new Error('ended before frame')))
  })
}

describe('GitHubBrokerServer', () => {
  it('serves PR follow-up through the signed socket and durable core without replaying after restart', async () => {
    const path = await privateSocketPath(), root = dirname(path), tokenPath = join(root, 'credentials', 'token')
    await mkdir(dirname(tokenPath), { mode: 0o700 })
    const secret = 'github_pat_socket_read_fixture'
    await writeFile(tokenPath, secret, { mode: 0o600 })
    const request = intent(), client = actionOptions(path)
    const grant = withBrokerGrantDigest({ protocol: 'assistant-actions/external-github-grant/v1', id: request.grantId, revision: 1,
      clientKeyId: client.clientKeyId, owner: request.owner, sessionId: request.sessionId,
      destination: { ...request.destination, baseBranch: 'stable', paths: ['a.txt'] }, credentialId: 'github', expiresAt: Date.now() + 30_000,
      maxActions: 3, maxTotalBytes: 100_000, maxCostUnits: 5, allowedOperations: ['inspect'], allowedInspectKinds: ['pull-request', 'checks', 'reviews'],
      client: client.source, source: request.source, policyEpoch: 3, emergencyEpoch: 0 })
    const pr = { number: 42, state: 'open', merged: false, head: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } }, base: { ref: 'stable', repo: { full_name: 'owner/repo' } } }
    const inspect = vi.fn(async (input: Parameters<typeof import('../src/github.js').inspectGitHub>[0]) => {
      expect(input.token).toBe(secret)
      expect(input.grant.repoWorkflow).toEqual({ baseBranch: 'stable', allowBranchCreate: false, allowPullRequest: false })
      return { observed: input.kind === 'pull-request' ? { ...pr, untrusted: true }
        : { pullRequest: pr, headOid: pr.head.sha, items: [], truncated: true, untrusted: true } }
    })
    const config = { instanceId: 'broker-fixture', statePath: join(root, 'state.sqlite'), grants: [grant], policyEpoch: 3,
      credentials: [{ id: 'github', provider: 'linux-protected-file' as const, path: tokenPath, maxLeaseMs: 30_000 }] }
    const backend = new ExternalBrokerCore(config, { inspect })
    const server = await start({ path, generation: backend.snapshot().generation, core: backend })
    const options = { ...client, minimumServerGeneration: backend.snapshot().generation }
    const requests: BrokerRequestIntent[] = ['pull-request', 'checks', 'reviews'].map(kind => ({ ...request,
      actionId: kind, callId: kind, grantDigest: grant.digest, destination: { ...request.destination, baseBranch: 'stable' },
      payload: { kind: kind as 'pull-request' | 'checks' | 'reviews', pullRequestNumber: 42 },
      budget: { ...request.budget, reservationId: kind, bytes: Buffer.byteLength(JSON.stringify({ kind, pullRequestNumber: 42 })), maxCostUnits: kind === 'pull-request' ? 1 : 2 } }))
    const replies = []
    for (const entry of requests) {
      const reply = await requestGitHubBroker(options, entry)
      expect(reply, reply.error?.code).toMatchObject({ status: 'succeeded', result: { operation: 'inspect', observed: { untrusted: true } } })
      expect(JSON.stringify(reply)).not.toContain(secret)
      replies.push(reply)
    }
    expect(inspect).toHaveBeenCalledTimes(3)
    const denied = await requestGitHubBroker(options, { ...requests[2]!, actionId: 'over-budget', callId: 'over-budget', budget: { ...requests[2]!.budget, reservationId: 'over-budget' } })
    expect(denied).toMatchObject({ status: 'failed', dispatched: false })
    expect(inspect).toHaveBeenCalledTimes(3)
    await server.stop()
    const restored = new ExternalBrokerCore(config, { inspect })
    const restoredServer = await start({ path, generation: restored.snapshot().generation, core: restored })
    const repeated = await requestGitHubBroker({ ...actionOptions(restoredServer.actionSocketPath), minimumServerGeneration: restored.snapshot().generation }, requests[2]!)
    expect(repeated.result).toEqual(replies[2]!.result)
    expect(inspect).toHaveBeenCalledTimes(3)
  })

  it('serves exactly one signed action request over a private verified socket', async () => {
    const execute = vi.fn(async (request: BrokerClientRequest) => response(request))
    const server = await start({ core: core({ execute }) })
    const result = await requestGitHubBroker(actionOptions(server.actionSocketPath), intent())
    expect(result, result.error?.code).toMatchObject({ status: 'succeeded' })
    expect(result.result).toMatchObject({ operation: 'inspect', repository: 'owner/repo', branch: 'main' })
    expect(execute).toHaveBeenCalledOnce()
    expect((await lstat(server.actionSocketPath)).mode & 0o7777).toBe(0o600)
  })

  it('routes signed admin requests through the core without opening a ledger', async () => {
    const admin = vi.fn(async (_request: BrokerAdminRequest): Promise<Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>> => ({ status: 'succeeded', state: { admission: 'accepting', generation: 7, controlVersion: 12, activeRequests: 0, revocationEpoch: 5 }, error: null, completedAt: Date.now() }))
    const server = await start({ core: core({ admin }) })
    const result = await requestGitHubBrokerAdmin(connectionOptions(server.adminSocketPath), { operation: 'status', body: {}, deadline: Date.now() + 5_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)
    expect(result).toMatchObject({ status: 'succeeded', state: { controlVersion: 12, revocationEpoch: 5 } })
    expect(admin).toHaveBeenCalledOnce()
  })

  it('authorizes action and admin identities only after their signed request selects a role', async () => {
    let selected = { uid: uid + 10, gid: gid + 10 }
    const peer: BrokerPeerCredentialInspector = () => selected
    const server = await start({ peer, clientPeer: selected, adminPeer: { uid: uid + 20, gid: gid + 20 } })
    await expect(requestGitHubBroker(actionOptions(server.actionSocketPath), intent())).resolves.toMatchObject({ status: 'succeeded' })
    selected = { uid: uid + 20, gid: gid + 20 }
    await expect(requestGitHubBrokerAdmin(connectionOptions(server.adminSocketPath), { operation: 'status', body: {}, deadline: Date.now() + 5_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)).resolves.toMatchObject({ status: 'succeeded' })
    selected = { uid: uid + 20, gid: gid + 20 }
    await expect(requestGitHubBroker(actionOptions(server.actionSocketPath), intent())).rejects.toMatchObject({ code: 'disconnected' })
    selected = { uid: uid + 10, gid: gid + 10 }
    await expect(requestGitHubBrokerAdmin(connectionOptions(server.adminSocketPath), { operation: 'status', body: {}, deadline: Date.now() + 5_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('rejects admin frames on the action listener and action frames on the admin listener', async () => {
    const server = await start()
    await expect(requestGitHubBrokerAdmin(connectionOptions(server.actionSocketPath), { operation: 'status', body: {}, deadline: Date.now() + 5_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)).rejects.toMatchObject({ code: 'disconnected' })
    await expect(requestGitHubBroker(actionOptions(server.adminSocketPath), intent())).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('rejects shared action/admin key ids and any shared signing key material before bind', async () => {
    const firstPath = await privateSocketPath()
    await expect(start({ path: firstPath, adminKeyId: 'client-fixture' })).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(lstat(firstPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const secondPath = await privateSocketPath()
    await expect(start({ path: secondPath, adminPublicKey: clientKeys.publicKey })).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(lstat(secondPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const thirdPath = await privateSocketPath()
    await expect(startGitHubBrokerServer({ actionSocketPath: thirdPath, adminSocketPath: join(dirname(dirname(thirdPath)), 'admin-runtime', 'broker-admin.sock'), instanceId: 'broker-fixture', generation: 7, serverPrivateKey: clientKeys.privateKey, clientPublicKey: clientKeys.publicKey, clientKeyId: 'client-fixture', adminPublicKey: adminKeys.publicKey, adminKeyId: 'admin-fixture', core: core(), inspectPeerCredentials: trustedPeer, expectedClientPeerUid: uid, expectedClientPeerGid: gid, expectedAdminPeerUid: uid, expectedAdminPeerGid: gid, expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: 0o700, expectedActionSocketMode: 0o600, expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600 })).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(lstat(thirdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never admits action work before the admin listener binds and cleans the provisional action socket on failure', async () => {
    const actionSocketPath = await privateSocketPath(), adminDirectory = join(dirname(dirname(actionSocketPath)), 'admin-runtime')
    await mkdir(adminDirectory, { mode: 0o700 }); await chmod(adminDirectory, 0o700)
    const adminSocketPath = join(adminDirectory, 'broker-admin.sock'), occupied = createServer()
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(adminSocketPath, resolve) }); await chmod(adminSocketPath, 0o600); replacements.push(occupied)
    const execute = vi.fn(async (request: BrokerClientRequest) => response(request))
    const starting = startGitHubBrokerServer({
      actionSocketPath, adminSocketPath, instanceId: 'broker-fixture', generation: 7, serverPrivateKey: serverKeys.privateKey, clientPublicKey: clientKeys.publicKey, clientKeyId: 'client-fixture', adminPublicKey: adminKeys.publicKey, adminKeyId: 'admin-fixture', core: core({ execute }), inspectPeerCredentials: trustedPeer,
      expectedClientPeerUid: uid, expectedClientPeerGid: gid, expectedAdminPeerUid: uid, expectedAdminPeerGid: gid, expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: 0o700, expectedActionSocketMode: 0o600, expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600,
    })
    await expect(starting).rejects.toMatchObject({ code: 'unsafe-socket' })
    expect(execute).not.toHaveBeenCalled()
    await expect(lstat(actionSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(adminSocketPath)).isSocket()).toBe(true)
  })

  it('fails closed before hello when native peer inspection is unavailable', async () => {
    const server = await start({ peer: () => undefined })
    const socket = await connect(server.actionSocketPath)
    await expect(new Promise<void>((resolve, reject) => { socket.once('close', () => resolve()); socket.once('data', () => reject(new Error('unexpected hello'))) })).resolves.toBeUndefined()
  })

  it('enforces first-byte and total deadlines against idle or hung peers', async () => {
    const idle = await start({ firstByteTimeoutMs: 20, frameTimeoutMs: 40, totalTimeoutMs: 80 })
    const socket = await connect(idle.actionSocketPath)
    await nextFrame(socket)
    await expect(new Promise<void>(resolve => socket.once('close', () => resolve()))).resolves.toBeUndefined()

    const hangingPath = await privateSocketPath()
    const hanging = await start({ path: hangingPath, peer: async (_socket, signal) => await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), firstByteTimeoutMs: 20, frameTimeoutMs: 40, totalTimeoutMs: 60 })
    const hangingSocket = await connect(hanging.actionSocketPath)
    await expect(new Promise<void>(resolve => hangingSocket.once('close', () => resolve()))).resolves.toBeUndefined()
  })

  it('rejects a second frame and aborts the verified request connection', async () => {
    const execute = vi.fn(async (_request: BrokerClientRequest, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const server = await start({ core: core({ execute }) })
    const socket = await connect(server.actionSocketPath)
    const hello = verifyBrokerServerHello(await nextFrame(socket), serverKeys.publicKey)
    const request = createBrokerClientRequest(intent(), hello, { kind: 'assistant-actions-host', instanceId: 'host-fixture', generation: 2 }, 'client-fixture', clientKeys.privateKey)
    const frame = encodeBrokerFrame(request, 8 * 1024 * 1024)
    socket.write(Buffer.concat([frame, frame]))
    await expect(new Promise<void>(resolve => socket.once('close', () => resolve()))).resolves.toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it('stops admission, aborts incomplete frames, drains core, and unlinks only its own inode', async () => {
    const calls: string[] = []
    const path = await privateSocketPath()
    const server = await start({ path, core: core({ beginDrain: reason => { calls.push(`begin:${reason}`) }, drain: async () => { calls.push('drain') }, close: () => { calls.push('close') } }) })
    const incomplete = await connect(path)
    await nextFrame(incomplete)
    await server.stop('sigterm', 100)
    expect(calls).toEqual(['begin:sigterm', 'drain', 'close'])
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still closes, aborts, drains, and releases the socket when beginDrain fails', async () => {
    const calls: string[] = [], path = await privateSocketPath()
    const server = await start({ path, core: core({ beginDrain: () => { calls.push('begin'); throw new Error('fixture failure') }, drain: async () => { calls.push('drain') }, close: () => { calls.push('close') } }) })
    const incomplete = await connect(path); await nextFrame(incomplete)
    await expect(server.stop('lifecycle', 100)).rejects.toMatchObject({ code: 'shutdown-failed' })
    expect(calls).toEqual(['begin', 'drain', 'close'])
    expect(incomplete.destroyed).toBe(true)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds shutdown after a valid response when the client keeps its write half open', async () => {
    const server = await start()
    const socket = await connect(server.actionSocketPath)
    const hello = verifyBrokerServerHello(await nextFrame(socket), serverKeys.publicKey)
    const request = createBrokerClientRequest(intent(), hello, { kind: 'assistant-actions-host', instanceId: 'host-fixture', generation: 2 }, 'client-fixture', clientKeys.privateKey)
    socket.write(encodeBrokerFrame(request, 8 * 1024 * 1024))
    await nextFrame(socket)
    const startedAt = Date.now()
    await server.stop('lifecycle', 100)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(socket.destroyed).toBe(true)
    await expect(lstat(server.actionSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(server.adminSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds shutdown when every core barrier ignores cancellation', async () => {
    const never = new Promise<never>(() => {})
    const server = await start({ core: core({ beginDrain: () => never, drain: async () => await never, close: async () => await never }) })
    const startedAt = Date.now()
    await expect(server.stop('lifecycle', 60)).rejects.toMatchObject({ code: 'shutdown-failed' })
    expect(Date.now() - startedAt).toBeLessThan(500)
    await expect(lstat(server.actionSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(server.adminSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a replacement socket during shutdown', async () => {
    const path = await privateSocketPath()
    const server = await start({ path })
    await unlink(path)
    const replacement = createServer(socket => socket.end())
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, () => resolve()) })
    await chmod(path, 0o600); replacements.push(replacement)
    const replacementIdentity = await lstat(path)
    await server.stop()
    const after = await lstat(path)
    expect([after.dev, after.ino]).toEqual([replacementIdentity.dev, replacementIdentity.ino])
  })

  it.each(['regular', 'symlink', 'wrong-mode'] as const)('never deletes an unowned %s replacement during shutdown', async kind => {
    const path = await privateSocketPath(), server = await start({ path })
    await unlink(path)
    let replacementIdentity: Awaited<ReturnType<typeof lstat>>, expectedContent: string | undefined
    if (kind === 'regular') {
      expectedContent = 'foreign-data'; await writeFile(path, expectedContent, { mode: 0o600 }); replacementIdentity = await lstat(path)
    } else if (kind === 'symlink') {
      const target = join(dirname(path), 'foreign-target'); expectedContent = 'foreign-target'; await writeFile(target, expectedContent, { mode: 0o600 }); await symlink(target, path); replacementIdentity = await lstat(path)
    } else {
      const replacement = createServer(socket => socket.end()); await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, resolve) }); await chmod(path, 0o666); replacements.push(replacement); replacementIdentity = await lstat(path)
    }
    await expect(server.stop('lifecycle', 100)).rejects.toMatchObject({ code: 'shutdown-failed' })
    const after = await lstat(path)
    expect([after.dev, after.ino, after.mode]).toEqual([replacementIdentity.dev, replacementIdentity.ino, replacementIdentity.mode])
    if (expectedContent !== undefined) expect(await import('node:fs/promises').then(module => module.readFile(path, 'utf8'))).toBe(expectedContent)
    await expect(connect(server.adminSocketPath)).rejects.toBeDefined()
  })

  it('rejects active and unauthenticated occupied sockets without unlinking them', async () => {
    const activePath = await privateSocketPath()
    await start({ path: activePath })
    await expect(start({ path: activePath })).rejects.toMatchObject({ code: 'already-running' })
    expect((await lstat(activePath)).isSocket()).toBe(true)

    const untrustedPath = await privateSocketPath()
    const untrusted = createServer(socket => socket.end('not a signed hello'))
    await new Promise<void>((resolve, reject) => { untrusted.once('error', reject); untrusted.listen(untrustedPath, () => resolve()) })
    await chmod(untrustedPath, 0o600); replacements.push(untrusted)
    await expect(start({ path: untrustedPath })).rejects.toMatchObject({ code: 'unsafe-socket' })
    expect((await lstat(untrustedPath)).isSocket()).toBe(true)
  })

  it('bounds concurrent verified requests without queueing them', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async (request: BrokerClientRequest) => { await held; return response(request) })
    const server = await start({ core: core({ execute }), maxConcurrentRequests: 1 })
    const first = requestGitHubBroker(actionOptions(server.actionSocketPath), intent())
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const secondIntent = { ...intent(), actionId: 'action-2', callId: 'call-2' }
    const second = await requestGitHubBroker(actionOptions(server.actionSocketPath), secondIntent)
    expect(second).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'broker-busy' } })
    expect(execute).toHaveBeenCalledOnce()
    release(); await expect(first).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('keeps admin status available while slow clients fill the action listener', async () => {
    const server = await start({ maxActionConnections: 2, maxAdminConnections: 1, firstByteTimeoutMs: 500, frameTimeoutMs: 600, totalTimeoutMs: 800 })
    const slow = [await connect(server.actionSocketPath), await connect(server.actionSocketPath)]
    await Promise.all(slow.map(nextFrame))
    const result = await requestGitHubBrokerAdmin(connectionOptions(server.adminSocketPath), { operation: 'status', body: {}, deadline: Date.now() + 1_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)
    expect(result).toMatchObject({ status: 'succeeded', state: { generation: 7 } })
    for (const socket of slow) socket.destroy()
  })

  it('keeps admin stop available while slow clients fill the action listener', async () => {
    const admin = vi.fn(async (_request: BrokerAdminRequest): Promise<Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>> => ({ status: 'succeeded', state: { admission: 'stopped', generation: 7, controlVersion: 10, activeRequests: 0, revocationEpoch: 3 }, error: null, completedAt: Date.now() }))
    const server = await start({ core: core({ admin }), maxActionConnections: 2, maxAdminConnections: 1, firstByteTimeoutMs: 500, frameTimeoutMs: 600, totalTimeoutMs: 800 })
    const slow = [await connect(server.actionSocketPath), await connect(server.actionSocketPath)]
    await Promise.all(slow.map(nextFrame))
    const result = await requestGitHubBrokerAdmin(connectionOptions(server.adminSocketPath), { operation: 'stop', body: { expectedControlVersion: 9, drainDeadline: Date.now() + 1_000, reason: 'security-response' }, deadline: Date.now() + 1_000 }, { kind: 'assistant-actions-admin', instanceId: 'operator-fixture', generation: 1 }, 'admin-fixture', adminKeys.privateKey)
    expect(result).toMatchObject({ status: 'succeeded', state: { admission: 'stopped', controlVersion: 10 } })
    expect(admin).toHaveBeenCalledOnce()
    for (const socket of slow) socket.destroy()
  })

  it('rejects unsafe parents and fails closed instead of fabricating peer credentials', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'actions-broker-unsafe-')); roots.push(outer)
    await chmod(outer, 0o755)
    await expect(start({ path: join(outer, 'broker.sock') })).rejects.toMatchObject({ code: 'unsafe-parent' } satisfies Partial<GitHubBrokerServerError>)
  })

  it('supports an explicitly pinned group-traversable parent and group socket mode', async () => {
    const path = await privateSocketPath(0o750)
    const server = await start({ path, parentMode: 0o750, socketMode: 0o660 })
    expect((await lstat(join(path, '..'))).mode & 0o7777).toBe(0o750)
    expect((await lstat(path)).mode & 0o7777).toBe(0o660)
    await server.stop()
  })

  it('rejects writable socket parents and world-accessible socket modes', async () => {
    const writable = await privateSocketPath(0o770)
    await expect(start({ path: writable, parentMode: 0o770 })).rejects.toMatchObject({ code: 'invalid-config' })
    const world = await privateSocketPath()
    await expect(start({ path: world, socketMode: 0o606 })).rejects.toMatchObject({ code: 'invalid-config' })
  })
})

describe('broker CLI safety boundary', () => {
  async function configFile(socketPath: string, serve: boolean, extra: Record<string, unknown> = {}): Promise<string> {
    const directory = join(socketPath, '..')
    const serverPublic = join(directory, 'server-public.pem'), adminPrivate = join(directory, 'admin-private.pem'), adminPublic = join(directory, 'admin-public.pem')
    const clientPublic = join(directory, 'client-public.pem'), serverPrivate = join(directory, 'server-private.pem'), statePath = join(directory, 'broker.sqlite')
    await Promise.all([
      writeFile(serverPublic, serverKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(adminPrivate, adminKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
      writeFile(adminPublic, adminKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(clientPublic, clientKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 }),
      writeFile(serverPrivate, serverKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }),
    ])
    const path = join(directory, serve ? 'broker-daemon.json' : 'broker-operator.json')
    const adminDirectory = join(dirname(directory), 'admin-runtime'); await mkdir(adminDirectory, { recursive: true, mode: 0o700 }); await chmod(adminDirectory, 0o700)
    const adminSocketPath = join(adminDirectory, 'broker-admin.sock')
    const operator = { adminSocketPath, brokerId: 'broker-fixture', minimumBrokerGeneration: 7, brokerPublicKeyPath: serverPublic, expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminSocketMode: 0o600, expectedAdminParentUid: uid, expectedAdminParentGid: gid, expectedAdminParentMode: 0o700, expectedBrokerPeerUid: uid, expectedBrokerPeerGid: gid, requestTimeoutMs: 1_000, helloTtlMs: 30_000 }
    const selected = serve
      ? { actionSocketPath: socketPath, adminSocketPath, brokerId: 'broker-fixture', minimumBrokerGeneration: 7, serverPrivateKeyPath: serverPrivate, clientKeyId: 'client-fixture', clientPublicKeyPath: clientPublic, adminKeyId: 'admin-fixture', adminPublicKeyPath: adminPublic, statePath, expectedClientPeerUid: uid, expectedClientPeerGid: gid, expectedAdminPeerUid: uid, expectedAdminPeerGid: gid, expectedActionSocketUid: uid, expectedActionSocketGid: gid, expectedActionParentMode: 0o700, expectedActionSocketMode: 0o600, expectedAdminSocketUid: uid, expectedAdminSocketGid: gid, expectedAdminParentMode: 0o700, expectedAdminSocketMode: 0o600, maxActionConnections: 32, maxAdminConnections: 4, maxConcurrentRequests: 2, requestTimeoutMs: 1_000, helloTtlMs: 30_000, drainTimeoutMs: 200, credentials: [], grants: [], policyEpoch: 0, ...extra }
      : { ...operator, adminKeyId: 'admin-fixture', adminPrivateKeyPath: adminPrivate, adminInstanceId: 'operator-fixture', adminGeneration: 1, ...extra }
    await writeFile(path, JSON.stringify(selected), { mode: 0o600 })
    return path
  }

  it('fails before bind when the built-in peer credential inspector is unavailable', async () => {
    const socketPath = await privateSocketPath(), path = await configFile(socketPath, true)
    const before = await lstat(join(socketPath, '..'))
    const writes: string[] = []
    const code = await runBrokerCli(['serve', path], { createCore: () => core(), peerCredentialsAvailable: () => false, stderr: { write(value) { writes.push(String(value)); return true } } })
    expect(code).toBe(1)
    expect(writes).toEqual(['assistant-actions broker: command failed or invalid arguments\n'])
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(join(socketPath, '..'))).ino).toBe(before.ino)
  })

  it('parses only owner-private canonical config files', async () => {
    const socketPath = await privateSocketPath(), path = await configFile(socketPath, true)
    await expect(loadBrokerCliConfig(path, true)).resolves.toMatchObject({ brokerId: 'broker-fixture', expectedClientPeerUid: uid, expectedAdminPeerUid: uid })
    await chmod(path, 0o644)
    await expect(loadBrokerCliConfig(path, true)).rejects.toThrow('unsafe private file')
  })

  it('rejects shared action/admin key ids, paths, and equal key material before bind', async () => {
    const first = await privateSocketPath(), sameId = await configFile(first, true, { adminKeyId: 'client-fixture' })
    await expect(loadBrokerCliConfig(sameId, true)).rejects.toThrow('invalid serve config')
    const second = await privateSocketPath(), samePath = await configFile(second, true, { adminPublicKeyPath: join(second, '..', 'client-public.pem') })
    await expect(loadBrokerCliConfig(samePath, true)).rejects.toThrow('invalid serve config')
    const third = await privateSocketPath(), directory = dirname(third), equalMaterial = join(directory, 'admin-copy.pem')
    await writeFile(equalMaterial, clientKeys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 })
    const sameMaterial = await configFile(third, true, { adminPublicKeyPath: equalMaterial })
    const writes: string[] = []
    await expect(runBrokerCli(['serve', sameMaterial], { createCore: () => core(), peerInspector: trustedPeer, stderr: { write(value) { writes.push(String(value)); return true } } })).resolves.toBe(1)
    expect(writes).toEqual(['assistant-actions broker: command failed or invalid arguments\n'])
    await expect(lstat(third)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects malformed admin commands without connecting or leaking details', async () => {
    const socketPath = await privateSocketPath(), path = await configFile(socketPath, false)
    const writes: string[] = []
    const code = await runBrokerCli(['revoke', path, 'bad'], { stderr: { write(value) { writes.push(String(value)); return true } } })
    expect(code).toBe(1)
    expect(writes).toEqual(['assistant-actions broker: command failed or invalid arguments\n'])
  })

  it.runIf(linuxPeerCredentialsAvailable())('uses the production core, kernel peer credentials, and signed admin client without dependency injection', async () => {
    const socketPath = await privateSocketPath(), path = await configFile(socketPath, true, { minimumBrokerGeneration: 1 })
    const operatorPath = await configFile(socketPath, false, { minimumBrokerGeneration: 1 })
    const running = runBrokerCli(['serve', path], { stderr: { write() { return true } } })
    await vi.waitFor(async () => expect((await lstat(socketPath)).isSocket()).toBe(true))
    const output: string[] = []
    await expect(runBrokerCli(['status', operatorPath], { stdout: { write(value) { output.push(String(value)); return true } } })).resolves.toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'succeeded', state: { admission: 'accepting', generation: 1 } })
    process.emit('SIGTERM', 'SIGTERM')
    await expect(running).resolves.toBe(0)
    expect((await lstat(join(socketPath, '..', 'broker.sqlite'))).isFile()).toBe(true)
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'linux' && existsSync(brokerCliEntrypoint) && linuxPeerCredentialsAvailable())('runs the built broker CLI in separate serve and operator processes', async () => {
    const actionSocketPath = await privateSocketPath(), serveConfig = await configFile(actionSocketPath, true, { minimumBrokerGeneration: 1 })
    const operatorConfig = await configFile(actionSocketPath, false, { minimumBrokerGeneration: 1 })
    const child = spawn(process.execPath, [brokerCliEntrypoint, 'serve', serveConfig], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } })
    children.push(child)
    await vi.waitFor(async () => expect((await lstat(actionSocketPath)).isSocket()).toBe(true), { timeout: 5_000 })
    const run = promisify(execFile)
    const status = await run(process.execPath, [brokerCliEntrypoint, 'status', operatorConfig], { timeout: 5_000, maxBuffer: 16_384, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } })
    expect(JSON.parse(status.stdout)).toMatchObject({ status: 'succeeded', state: { admission: 'accepting', generation: 1, controlVersion: 0 } })
    const stop = await run(process.execPath, [brokerCliEntrypoint, 'stop', operatorConfig, '0', 'operator-request'], { timeout: 5_000, maxBuffer: 16_384, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } })
    expect(JSON.parse(stop.stdout)).toMatchObject({ status: 'succeeded', state: { admission: 'stopped', controlVersion: 1 } })
    child.kill('SIGTERM')
    await new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`broker child exited ${code}`))); child.once('error', reject) })
    await expect(lstat(actionSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
