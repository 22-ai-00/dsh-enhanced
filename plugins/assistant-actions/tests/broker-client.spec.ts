import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, unlinkSync } from 'node:fs'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerClientError, requestGitHubBroker, requestGitHubBrokerAdmin, type GitHubBrokerClientOptions, type GitHubBrokerConnectionOptions } from '../src/broker-client.ts'
import {
  BrokerFrameDecoder, GITHUB_BROKER_REQUEST_MAX_BYTES, createBrokerAdminResponse, createBrokerServerHello, createBrokerServerResponse, encodeBrokerFrame, verifyBrokerAdminRequest, verifyBrokerClientRequest,
  type BrokerAdminEndpoint, type BrokerClientRequest, type BrokerEndpoint, type BrokerRequestIntent, type BrokerServerHello,
} from '../src/broker-protocol.ts'

const roots: string[] = []
const replacements: Server[] = []
const serverKeys = generateKeyPairSync('ed25519')
const clientKeys = generateKeyPairSync('ed25519')
const adminKeys = generateKeyPairSync('ed25519')
const client: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }> = { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 3 }
const admin: BrokerAdminEndpoint = { kind: 'assistant-actions-admin', instanceId: 'admin-1', generation: 4 }
const intent = (): BrokerRequestIntent => ({
  actionId: 'action-1', grantId: 'grant-1', grantRevision: 2, grantDigest: 'a'.repeat(64),
  owner: { principalDigest: 'b'.repeat(64), principalRecordId: 'record-1', principalVersion: 1, workspace: '/workspace', preset: 'primary', bindingId: 'binding-1', bindingVersion: 2, bindingGeneration: 3 },
  sessionId: 'session-1', agentId: 'agent-1', rootCallId: 'root-call-1', callId: 'call-1', operation: 'commit',
  source: { classification: 'confidential', provenanceDigest: 'c'.repeat(64) }, destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main' },
  payload: { expectedHeadOid: 'd'.repeat(40), headline: 'Update file', files: [{ path: 'src/file.txt', content: 'hello' }] },
  deadline: Date.now() + 10_000, budget: { reservationId: 'reservation-1', actions: 1, bytes: 123, costMetric: 'github-api-units', maxCostUnits: 10 },
})

afterEach(async () => {
  await Promise.all(replacements.splice(0).map(async server => await close(server)))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function socketServer(handler: (socket: Socket) => void): Promise<{ root: string; path: string; server: Server }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'abc-'))); roots.push(root)
  const path = join(root, 'broker.sock')
  const server = createServer(handler)
  await new Promise<void>((resolvePromise, rejectPromise) => { server.once('error', rejectPromise); server.listen(path, resolvePromise) })
  await chmod(path, 0o600)
  return { root, path, server }
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise, rejectPromise) => server.close(error => error ? rejectPromise(error) : resolvePromise()))
}
function options(path: string, override: Partial<GitHubBrokerClientOptions> = {}): GitHubBrokerClientOptions {
  return { socketPath: path, serverPublicKey: serverKeys.publicKey, clientPrivateKey: clientKeys.privateKey, clientKeyId: 'client-key-1', source: client, timeoutMs: 1_000, inspectPeerCredentials: () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, pid: process.pid }), expectedBrokerPeerUid: process.getuid?.() ?? 0, expectedBrokerPeerGid: process.getgid?.() ?? 0, ...override }
}
function hello(): BrokerServerHello {
  return createBrokerServerHello({ instanceId: 'broker-1', generation: 7, policyEpoch: 8, emergencyEpoch: 2, challenge: Buffer.alloc(32, 5).toString('base64url'), expiresAt: Date.now() + 5_000 }, serverKeys.privateKey)
}
function readOne(socket: Socket, onRequest: (value: unknown) => void): void {
  const decoder = new BrokerFrameDecoder(GITHUB_BROKER_REQUEST_MAX_BYTES)
  socket.on('data', chunk => { for (const value of decoder.push(chunk)) onRequest(value) })
}
function expectClientError(value: unknown, code: string, dispatchState: string): void {
  expect(value).toBeInstanceOf(BrokerClientError)
  expect(value).toMatchObject({ code, dispatchState, retryable: false })
}

describe('requestGitHubBroker', () => {
  it.runIf(process.platform === 'linux')('uses Linux SO_PEERCRED by default for a real Unix-domain peer', async () => {
    const fixture = await socketServer(socket => {
      const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => {
        const request = verifyBrokerClientRequest(value, greeting, clientKeys.publicKey)
        const response = createBrokerServerResponse({ status: 'failed', dispatched: false, result: null, error: { code: 'denied' }, completedAt: Date.now() }, request, greeting, serverKeys.privateKey)
        socket.end(encodeBrokerFrame(response, 2 * 1024 * 1024))
      })
    })
    const direct = options(fixture.path); delete direct.inspectPeerCredentials
    try { await expect(requestGitHubBroker(direct, intent())).resolves.toMatchObject({ status: 'failed', error: { code: 'denied' } }) } finally { await close(fixture.server) }
  })

  it('accepts explicitly pinned group-traversable cross-UID deployment modes', async () => {
    const fixture = await socketServer(socket => {
      const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => {
        const request = verifyBrokerClientRequest(value, greeting, clientKeys.publicKey)
        socket.end(encodeBrokerFrame(createBrokerServerResponse({ status: 'failed', dispatched: false, result: null, error: { code: 'denied' }, completedAt: Date.now() }, request, greeting, serverKeys.privateKey), 2 * 1024 * 1024))
      })
    })
    await chmod(fixture.root, 0o750); await chmod(fixture.path, 0o660)
    try {
      await expect(requestGitHubBroker(options(fixture.path, { expectedSocketParentMode: 0o750, expectedSocketMode: 0o660 }), intent())).resolves.toMatchObject({ status: 'failed', error: { code: 'denied' } })
    } finally { await close(fixture.server) }
  })

  it('uses a real one-request UDS connection and accepts fragmented signed frames only', async () => {
    let accepted: BrokerClientRequest | undefined, connections = 0
    const fixture = await socketServer(socket => {
      connections++
      const greeting = hello(), frame = encodeBrokerFrame(greeting, 2 * 1024 * 1024)
      socket.write(frame.subarray(0, 3)); setImmediate(() => socket.write(frame.subarray(3)))
      readOne(socket, value => {
        accepted = verifyBrokerClientRequest(value, greeting, clientKeys.publicKey, { expectedClientKeyId: 'client-key-1' })
        const response = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'commit', repository: accepted.destination.repository, branch: accepted.destination.branch, parentOid: (accepted.payload as { expectedHeadOid: string }).expectedHeadOid, commitOid: 'e'.repeat(40) }, error: null, completedAt: Date.now() }, accepted, greeting, serverKeys.privateKey)
        const reply = encodeBrokerFrame(response, 2 * 1024 * 1024)
        socket.write(reply.subarray(0, 7)); setImmediate(() => socket.end(reply.subarray(7)))
      })
    })
    try {
      await expect(requestGitHubBroker(options(fixture.path), intent())).resolves.toMatchObject({ status: 'succeeded', result: { operation: 'commit', commitOid: 'e'.repeat(40) } })
      expect(connections).toBe(1)
      expect(accepted).toMatchObject({ policyEpoch: 8, emergencyEpoch: 2, owner: { bindingId: 'binding-1' }, source: { classification: 'confidential' }, budget: { costMetric: 'github-api-units' } })
    } finally { await close(fixture.server) }
  })

  it('rejects symlink, non-socket, wrong mode and wrong uid before dispatch', async () => {
    const fixture = await socketServer(() => {})
    const link = join(fixture.root, 'link.sock'); await symlink(fixture.path, link)
    try {
      await expect(requestGitHubBroker(options(link), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-invalid', 'not-dispatched'); return true })
      await chmod(fixture.path, 0o660)
      await expect(requestGitHubBroker(options(fixture.path), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-invalid', 'not-dispatched'); return true })
      await chmod(fixture.path, 0o600)
      await expect(requestGitHubBroker(options(fixture.path, { expectedSocketUid: (process.getuid?.() ?? 0) + 1 }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-invalid', 'not-dispatched'); return true })
      await expect(requestGitHubBroker(options(fixture.path, { expectedSocketGid: (process.getgid?.() ?? 0) + 1 }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-invalid', 'not-dispatched'); return true })
    } finally { await close(fixture.server) }
    const file = join(fixture.root, 'regular'); await writeFile(file, 'not a socket', { mode: 0o600 })
    await expect(requestGitHubBroker(options(file), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-invalid', 'not-dispatched'); return true })
  })

  it('rejects malformed direct client options without attempting a connection', async () => {
    for (const invalid of [
      { socketPath: 'relative.sock' }, { socketPath: '/' }, { expectedSocketUid: -1 }, { expectedSocketGid: Number.NaN }, { expectedSocketMode: 0o1000 },
      { expectedSocketParentUid: -1 }, { expectedSocketParentGid: Number.NaN }, { expectedSocketParentMode: 0o1000 }, { expectedSocketParentMode: 0o720 }, { expectedSocketMode: 0o606 }, { expectedServerInstanceId: 'bad id' }, { minimumServerGeneration: Number.NaN },
      { expectedBrokerPeerUid: -1 }, { expectedBrokerPeerGid: Number.NaN },
    ]) await expect(requestGitHubBroker(options('/not-used.sock', invalid), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'invalid-config', 'not-dispatched'); return true })
  })

  it('rejects a socket pathname whose device/inode changes during connect', async () => {
    let path = ''
    const fixture = await socketServer(socket => {
      unlinkSync(path)
      const replacement = createServer(candidate => candidate.end())
      replacement.listen(path, () => chmodSync(path, 0o600)); replacements.push(replacement)
      socket.resume()
    })
    path = fixture.path
    try {
      await expect(requestGitHubBroker(options(path), intent())).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(BrokerClientError)
        expect(error).toMatchObject({ dispatchState: 'not-dispatched' })
        expect((error as BrokerClientError).code).toBe('socket-changed')
        return true
      })
    } finally { await close(fixture.server) }
  })

  it('rejects a connected socket whose kernel peer credentials do not match', async () => {
    const fixture = await socketServer(() => {})
    try {
      await expect(requestGitHubBroker(options(fixture.path, { inspectPeerCredentials: () => ({ uid: (process.getuid?.() ?? 0) + 1, gid: process.getgid?.() ?? 0 }) }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'socket-changed', 'not-dispatched'); return true })
    } finally { await close(fixture.server) }
  })

  it('distinguishes timeout and abort before dispatch from post-dispatch unknown', async () => {
    const preAborted = new AbortController(); preAborted.abort(new Error('already stopped'))
    await expect(requestGitHubBroker(options('/definitely/not/a/socket'), intent(), preAborted.signal)).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'aborted', 'not-dispatched'); return true })
    const noHello = await socketServer(() => {})
    try {
      await expect(requestGitHubBroker(options(noHello.path, { timeoutMs: 30 }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'timeout', 'not-dispatched'); return true })
    } finally { await close(noHello.server) }

    let dispatched: (() => void) | undefined
    const gotRequest = new Promise<void>(resolvePromise => { dispatched = resolvePromise })
    const afterWrite = await socketServer(socket => {
      const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => { verifyBrokerClientRequest(value, greeting, clientKeys.publicKey); dispatched?.() })
    })
    try {
      await expect(requestGitHubBroker(options(afterWrite.path, { timeoutMs: 40 }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'timeout', 'post-dispatch-unknown'); return true })
      await gotRequest
    } finally { await close(afterWrite.server) }

    let abortReceived: (() => void) | undefined
    const requestReceived = new Promise<void>(resolvePromise => { abortReceived = resolvePromise })
    const abortServer = await socketServer(socket => {
      const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => { verifyBrokerClientRequest(value, greeting, clientKeys.publicKey); abortReceived?.() })
    })
    const controller = new AbortController()
    try {
      const result = requestGitHubBroker(options(abortServer.path), intent(), controller.signal).catch(error => error as unknown)
      await requestReceived; controller.abort(new Error('stop'))
      expectClientError(await result, 'aborted', 'post-dispatch-unknown')
    } finally { await close(abortServer.server) }
  })

  it('runs the current authorization gate after hello and immediately before writing', async () => {
    let received = false
    const fixture = await socketServer(socket => { const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024)); socket.on('data', () => { received = true }) })
    const gate = new Error('owner binding changed')
    try {
      await expect(requestGitHubBroker(options(fixture.path, { beforeWrite: (greeting, request) => { expect(greeting.policyEpoch).toBe(8); expect(request.owner.bindingGeneration).toBe(3); throw gate } }), intent())).rejects.toSatisfy((error: unknown) => {
        expectClientError(error, 'authorization-rejected', 'not-dispatched')
        expect((error as Error).cause).toBe(gate)
        return true
      })
      await new Promise(resolvePromise => setImmediate(resolvePromise))
      expect(received).toBe(false)
    } finally { await close(fixture.server) }
  })

  it('bounds an asynchronous authorization gate and never writes after late settlement', async () => {
    let received = false, release: (() => void) | undefined
    const held = new Promise<void>(resolvePromise => { release = resolvePromise })
    const fixture = await socketServer(socket => { const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024)); socket.on('data', () => { received = true }) })
    try {
      await expect(requestGitHubBroker(options(fixture.path, { timeoutMs: 30, beforeWrite: async (_hello, _request, gateSignal) => { expect(gateSignal.aborted).toBe(false); await held; expect(gateSignal.aborted).toBe(true) } }), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'timeout', 'not-dispatched'); return true })
      release?.(); await new Promise(resolvePromise => setImmediate(resolvePromise))
      expect(received).toBe(false)
    } finally { await close(fixture.server) }
  })

  it('reports a signed but mismatched response as post-dispatch unknown and never reconnects', async () => {
    let connections = 0
    const fixture = await socketServer(socket => {
      connections++; const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => {
        const request = verifyBrokerClientRequest(value, greeting, clientKeys.publicKey)
        const forged = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'commit', repository: request.destination.repository, branch: request.destination.branch, parentOid: (request.payload as { expectedHeadOid: string }).expectedHeadOid, commitOid: 'e'.repeat(40) }, error: null, completedAt: Date.now() }, { ...request, actionId: 'other-action' }, greeting, serverKeys.privateKey)
        socket.end(encodeBrokerFrame(forged, 2 * 1024 * 1024))
      })
    })
    try {
      await expect(requestGitHubBroker(options(fixture.path), intent())).rejects.toSatisfy((error: unknown) => { expectClientError(error, 'protocol-error', 'post-dispatch-unknown'); return true })
      expect(connections).toBe(1)
    } finally { await close(fixture.server) }
  })

  it('reports disconnect, trailing data and oversized responses as post-dispatch unknown', async () => {
    for (const behavior of ['disconnect', 'trailing', 'oversized'] as const) {
      const fixture = await socketServer(socket => {
        const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
        readOne(socket, value => {
          verifyBrokerClientRequest(value, greeting, clientKeys.publicKey)
          if (behavior === 'disconnect') { socket.destroy(); return }
          if (behavior === 'oversized') { const header = Buffer.alloc(4); header.writeUInt32BE(2 * 1024 * 1024 + 1); socket.end(header); return }
          const request = value as BrokerClientRequest
          const response = createBrokerServerResponse({ status: 'failed', dispatched: false, result: null, error: { code: 'denied' }, completedAt: Date.now() }, request, greeting, serverKeys.privateKey)
          socket.end(Buffer.concat([encodeBrokerFrame(response, 2 * 1024 * 1024), Buffer.from([1])]))
        })
      })
      try {
        await expect(requestGitHubBroker(options(fixture.path), intent())).rejects.toSatisfy((error: unknown) => { expect(error).toBeInstanceOf(BrokerClientError); expect((error as BrokerClientError).dispatchState).toBe('post-dispatch-unknown'); return true })
      } finally { await close(fixture.server) }
    }
  })
})

describe('requestGitHubBrokerAdmin', () => {
  it('reuses the hardened UDS transport for signed operator control', async () => {
    const fixture = await socketServer(socket => {
      const greeting = hello(); socket.write(encodeBrokerFrame(greeting, 2 * 1024 * 1024))
      readOne(socket, value => {
        const request = verifyBrokerAdminRequest(value, greeting, adminKeys.publicKey, { expectedAdminKeyId: 'admin-key-1' })
        const response = createBrokerAdminResponse({ status: 'succeeded', state: { admission: 'accepting', generation: 7, controlVersion: 9, activeRequests: 0, revocationEpoch: 2 }, error: null, completedAt: Date.now() }, request, greeting, serverKeys.privateKey)
        socket.end(encodeBrokerFrame(response, 2 * 1024 * 1024))
      })
    })
    const connection: GitHubBrokerConnectionOptions = { socketPath: fixture.path, serverPublicKey: serverKeys.publicKey, timeoutMs: 1_000, inspectPeerCredentials: () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }), expectedBrokerPeerUid: process.getuid?.() ?? 0, expectedBrokerPeerGid: process.getgid?.() ?? 0 }
    try {
      await expect(requestGitHubBrokerAdmin(connection, { operation: 'status', body: {}, deadline: Date.now() + 5_000 }, admin, 'admin-key-1', adminKeys.privateKey)).resolves.toMatchObject({ status: 'succeeded', state: { controlVersion: 9 } })
    } finally { await close(fixture.server) }
  })
})
