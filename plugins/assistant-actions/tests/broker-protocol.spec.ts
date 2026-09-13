import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BrokerFrameDecoder, GITHUB_BROKER_PROTOCOL, GITHUB_BROKER_REQUEST_MAX_BYTES,
  brokerDigest, brokerGrantAuthorityDigest, brokerRequestDigest, brokerWireRequestDigest, canonicalBrokerJson, createBrokerAdminRequest, createBrokerAdminResponse, createBrokerGrantProjection,
  createBrokerClientRequest, createBrokerServerHello, createBrokerServerResponse, encodeBrokerFrame,
  verifyBrokerAdminRequest, verifyBrokerAdminResponse, verifyBrokerClientRequest, verifyBrokerServerHello, verifyBrokerServerResponse,
  type BrokerAdminEndpoint, type BrokerEndpoint, type BrokerRequestIntent,
} from '../src/broker-protocol.ts'

const now = 1_800_000_000_000
const serverKeys = generateKeyPairSync('ed25519')
const clientKeys = generateKeyPairSync('ed25519')
const adminKeys = generateKeyPairSync('ed25519')
const client: BrokerEndpoint = { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 7 }
const admin: BrokerAdminEndpoint = { kind: 'assistant-actions-admin', instanceId: 'operator-1', generation: 3 }
const hello = () => createBrokerServerHello({ instanceId: 'broker-1', generation: 11, policyEpoch: 12, emergencyEpoch: 4, expiresAt: now + 10_000, challenge: Buffer.alloc(32, 7).toString('base64url') }, serverKeys.privateKey)
const intent = (): BrokerRequestIntent => ({
  actionId: 'action-1', grantId: 'grant-1', grantRevision: 5, grantDigest: 'a'.repeat(64),
  owner: { principalDigest: 'b'.repeat(64), principalRecordId: 'owner-record', principalVersion: 6, workspace: '/workspace', preset: 'primary', bindingId: 'binding-1', bindingVersion: 8, bindingGeneration: 9 },
  sessionId: 'session-1', agentId: 'agent-1', rootCallId: 'root-call-1', callId: 'call-1', operation: 'commit',
  source: { classification: 'confidential', provenanceDigest: 'c'.repeat(64) },
  destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main' },
  payload: { expectedHeadOid: 'd'.repeat(40), headline: 'Update file', files: [{ path: 'src/file.txt', content: 'hello' }] },
  deadline: now + 20_000, budget: { reservationId: 'reservation-1', actions: 1, bytes: 123, costMetric: 'github-api-units', maxCostUnits: 10 },
})

describe('broker canonical framing', () => {
  it('sorts exact integer-only JSON and produces stable SHA-256 digests', () => {
    expect(canonicalBrokerJson({ z: [true, null], a: { y: 2, x: 'one' } })).toBe('{"a":{"x":"one","y":2},"z":[true,null]}')
    expect(brokerDigest({ b: 2, a: 1 })).toBe(brokerDigest({ a: 1, b: 2 }))
    expect(() => canonicalBrokerJson({ value: 1.5 })).toThrowError(/safe canonical integers/)
    expect(() => canonicalBrokerJson({ token: 'secret' })).toThrowError(/credentials are forbidden/)
  })

  it('decodes a fragmented 4-byte big-endian frame and rejects trailing frames', () => {
    const frame = encodeBrokerFrame({ protocol: GITHUB_BROKER_PROTOCOL }, 1024)
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    const decoder = new BrokerFrameDecoder(1024)
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(frame.subarray(2, 7))).toEqual([])
    expect(decoder.push(frame.subarray(7))).toEqual([{ protocol: GITHUB_BROKER_PROTOCOL }])
    decoder.finish()
    expect(() => decoder.push(Buffer.from([0]))).toThrowError(/follow the final frame/)
  })

  it('rejects malformed, non-canonical, oversized, truncated and multi-frame inputs', () => {
    const raw = (text: string) => { const body = Buffer.from(text); const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame }
    expect(() => new BrokerFrameDecoder(100).push(raw('{bad'))).toThrowError(/valid JSON/)
    expect(() => new BrokerFrameDecoder(100).push(raw('{"b":1,"a":2}'))).toThrowError(/not canonical/)
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(101)
    expect(() => new BrokerFrameDecoder(100).push(oversized)).toThrowError(/exceeds/)
    expect(() => new BrokerFrameDecoder(100).push(Buffer.alloc(4))).toThrowError(/empty frames/)
    const truncated = new BrokerFrameDecoder(100); truncated.push(Buffer.from([0, 0, 0, 3, 123]))
    expect(() => truncated.finish()).toThrowError(/during a frame/)
    const frame = encodeBrokerFrame({}, 100)
    expect(() => new BrokerFrameDecoder(100).push(Buffer.concat([frame, frame]))).toThrowError(/follow the final frame/)
    expect(() => encodeBrokerFrame({ data: 'x'.repeat(100) }, 10)).toThrowError(/exceeds/)
    expect(() => encodeBrokerFrame({}, 0x1_0000_0000)).toThrowError(/limit/)
    expect(() => new BrokerFrameDecoder(0x1_0000_0000)).toThrowError(/limit/)
    const sparse: unknown[] = []; sparse.length = 1_000_000
    expect(() => canonicalBrokerJson(sparse)).toThrowError(/complexity/)
    const wide = raw(`[${'0,'.repeat(200_000)}0]`)
    expect(() => new BrokerFrameDecoder(wide.length).push(wide)).toThrowError(/complexity/)
  })
})

describe('broker action authentication', () => {
  it('binds hello epochs and every frozen lease/request identity into Ed25519 signatures', () => {
    const signedHello = hello()
    expect(verifyBrokerServerHello(signedHello, serverKeys.publicKey, { now })).toEqual(signedHello)
    const request = createBrokerClientRequest(intent(), signedHello, client, 'client-key-1', clientKeys.privateKey, 'request-1')
    expect(request).toMatchObject({ policyEpoch: 12, emergencyEpoch: 4, client, broker: { kind: 'github-broker', instanceId: 'broker-1', generation: 11 } })
    expect(verifyBrokerClientRequest(request, signedHello, clientKeys.publicKey, { now, expectedClientKeyId: 'client-key-1' })).toEqual(request)
    expect(brokerRequestDigest(request)).toMatch(/^[0-9a-f]{64}$/)

    for (const replacement of [
      { actionId: 'action-2' }, { grantRevision: 6 }, { grantDigest: '9'.repeat(64) },
      { owner: { ...request.owner, principalDigest: '8'.repeat(64) } }, { owner: { ...request.owner, principalRecordId: 'other-record' } }, { owner: { ...request.owner, principalVersion: 7 } },
      { owner: { ...request.owner, workspace: '/other' } }, { owner: { ...request.owner, preset: 'other' } }, { owner: { ...request.owner, bindingId: 'binding-2' } },
      { owner: { ...request.owner, bindingVersion: 9 } }, { owner: { ...request.owner, bindingGeneration: 10 } }, { sessionId: 'session-2' },
      { agentId: 'agent-2' }, { rootCallId: 'root-call-2' }, { callId: 'call-2' },
      { source: { ...request.source, classification: 'restricted' } }, { source: { ...request.source, provenanceDigest: '7'.repeat(64) } },
      { destination: { ...request.destination, repository: 'owner/other' } }, { destination: { ...request.destination, branch: 'other' } },
      { payload: { ...(request.payload as { expectedHeadOid: string; headline: string; files: unknown[] }), headline: 'Other' }, payloadDigest: brokerDigest({ ...(request.payload as object), headline: 'Other' }) },
      { deadline: request.deadline + 1 },
      { budget: { ...request.budget, reservationId: 'reservation-2' } }, { budget: { ...request.budget, actions: 2 } }, { budget: { ...request.budget, bytes: 124 } }, { budget: { ...request.budget, maxCostUnits: 11 } },
    ]) expect(() => verifyBrokerClientRequest({ ...request, ...replacement }, signedHello, clientKeys.publicKey, { now })).toThrowError(/signature verification/)
    for (const replacement of [{ policyEpoch: 13 }, { emergencyEpoch: 5 }]) expect(() => verifyBrokerClientRequest({ ...request, ...replacement }, signedHello, clientKeys.publicKey, { now })).toThrowError(/not bound/)
    expect(() => verifyBrokerClientRequest({ ...request, payloadDigest: '6'.repeat(64) }, signedHello, clientKeys.publicKey, { now })).toThrowError(/payload digest/)
    expect(() => verifyBrokerClientRequest({ ...request, destination: { ...request.destination, classification: 'other' } }, signedHello, clientKeys.publicKey, { now })).toThrowError(/destination/)
    expect(() => verifyBrokerClientRequest({ ...request, budget: { ...request.budget, costMetric: 'other' } }, signedHello, clientKeys.publicKey, { now })).toThrowError(/cost metric/)
  })

  it('rejects unknown fields, malformed signatures, stale hello and challenge/epoch replay', () => {
    const signedHello = hello(), request = createBrokerClientRequest(intent(), signedHello, client, 'client-key-1', clientKeys.privateKey, 'request-1')
    expect(() => verifyBrokerServerHello({ ...signedHello, extra: true }, serverKeys.publicKey, { now })).toThrowError(/unknown or missing/)
    expect(() => verifyBrokerClientRequest({ ...request, extra: true }, signedHello, clientKeys.publicKey, { now })).toThrowError(/unknown or missing/)
    expect(() => verifyBrokerClientRequest({ ...request, signature: Buffer.alloc(64).toString('base64url') }, signedHello, clientKeys.publicKey, { now })).toThrowError(/signature verification/)
    expect(() => verifyBrokerServerHello(signedHello, serverKeys.publicKey, { now: signedHello.expiresAt })).toThrowError(/expired/)
    const nextHello = createBrokerServerHello({ instanceId: signedHello.instanceId, generation: signedHello.generation, policyEpoch: signedHello.policyEpoch + 1, emergencyEpoch: signedHello.emergencyEpoch, expiresAt: now + 10_000, challenge: signedHello.challenge }, serverKeys.privateKey)
    expect(() => verifyBrokerClientRequest(request, nextHello, clientKeys.publicKey, { now })).toThrowError(/not bound/)
    expect(() => verifyBrokerClientRequest(request, signedHello, clientKeys.publicKey, { now, expectedClientKeyId: 'other-key' })).toThrowError(/identity/)
  })

  it('keeps semantic action identity stable across handshakes while wire identity changes', () => {
    const firstHello = hello()
    const secondHello = createBrokerServerHello({ instanceId: 'broker-1', generation: 12, policyEpoch: 13, emergencyEpoch: 5, expiresAt: now + 10_000, challenge: Buffer.alloc(32, 6).toString('base64url') }, serverKeys.privateKey)
    const first = createBrokerClientRequest(intent(), firstHello, client, 'client-key-1', clientKeys.privateKey, 'wire-1')
    const second = createBrokerClientRequest({ ...intent(), agentId: 'agent-restarted', rootCallId: 'new-root-call', callId: 'new-call', deadline: intent().deadline + 5_000 }, secondHello, client, 'client-key-1', clientKeys.privateKey, 'wire-2')
    expect(brokerRequestDigest(first)).toBe(brokerRequestDigest(second))
    expect(brokerWireRequestDigest(first)).not.toBe(brokerWireRequestDigest(second))
    expect(brokerRequestDigest(createBrokerClientRequest({ ...intent(), payload: { ...(intent().payload as { expectedHeadOid: string; headline: string; files: Array<{ path: string; content: string }> }), headline: 'Changed' } }, firstHello, client, 'client-key-1', clientKeys.privateKey))).not.toBe(brokerRequestDigest(first))
    expect(brokerRequestDigest(createBrokerClientRequest({ ...intent(), owner: { ...intent().owner, bindingGeneration: 10 } }, firstHello, client, 'client-key-1', clientKeys.privateKey))).not.toBe(brokerRequestDigest(first))
  })

  it('derives one full-authority grant digest and a reduced read-only projection', () => {
    const authority = { protocol: 'assistant-actions/external-github-grant/v1' as const, id: 'grant-1', revision: 5, clientKeyId: 'client-key-1', owner: intent().owner, sessionId: intent().sessionId,
      destination: { ...intent().destination, paths: ['src/file.txt'] }, credentialId: 'github-owner-token', expiresAt: now + 50_000, maxActions: 3, maxTotalBytes: 4096, maxCostUnits: 10, allowedOperations: ['commit', 'inspect'] as const, allowedInspectKinds: ['file'] as const,
      client, source: intent().source, policyEpoch: 12, emergencyEpoch: 4 }
    const projection = createBrokerGrantProjection(authority)
    expect(projection).toMatchObject({ grantDigest: brokerGrantAuthorityDigest(authority), owner: { bindingGeneration: 9 }, sessionId: 'session-1', destination: { paths: ['src/file.txt'] }, allowedOperations: ['commit', 'inspect'], allowedInspectKinds: ['file'] })
    expect(projection).not.toHaveProperty('credentialId')
    expect(projection).not.toHaveProperty('clientKeyId')
    expect(projection).not.toHaveProperty('policyEpoch')
    expect(brokerGrantAuthorityDigest({ ...authority, credentialId: 'other-token' })).not.toBe(projection.grantDigest)
  })

  it('preserves legacy grant canonical form while binding pull-request authority to an explicit base branch', () => {
    const authority = { protocol: 'assistant-actions/external-github-grant/v1' as const, id: 'grant-1', revision: 5, clientKeyId: 'client-key-1', owner: intent().owner, sessionId: intent().sessionId,
      destination: { ...intent().destination, paths: ['src/file.txt'] }, credentialId: 'github-owner-token', expiresAt: now + 50_000, maxActions: 3, maxTotalBytes: 4096, maxCostUnits: 10, allowedOperations: ['inspect'] as const, allowedInspectKinds: ['file'] as const,
      client, source: intent().source, policyEpoch: 12, emergencyEpoch: 4 }
    expect(createBrokerGrantProjection(authority).destination).not.toHaveProperty('baseBranch')
    expect(brokerGrantAuthorityDigest(authority)).toBe(brokerDigest(authority))
    const scoped = { ...authority, destination: { ...authority.destination, baseBranch: 'release' }, allowedInspectKinds: ['pull-request', 'checks', 'reviews'] as const }
    expect(createBrokerGrantProjection(scoped).destination).toMatchObject({ branch: 'main', baseBranch: 'release' })
    expect(() => createBrokerGrantProjection({ ...scoped, destination: { ...scoped.destination, baseBranch: 'main' } })).toThrowError(/base branch/)
    expect(() => createBrokerGrantProjection({ ...authority, allowedInspectKinds: ['pull-request'] as const })).toThrowError(/base branch/)
  })

  it('projects verified delivery metadata only when explicitly granted', () => {
    const authority = { protocol: 'assistant-actions/external-github-grant/v1' as const, id: 'grant-1', revision: 5, clientKeyId: 'client-key-1', owner: intent().owner, sessionId: intent().sessionId,
      destination: { ...intent().destination, baseBranch: 'stable', paths: ['src/file.txt'] }, credentialId: 'github-owner-token', expiresAt: now + 50_000, maxActions: 3, maxTotalBytes: 4096, maxCostUnits: 10, allowedOperations: ['commit', 'pull-request'] as const, allowedInspectKinds: [] as const,
      client, source: intent().source, policyEpoch: 12, emergencyEpoch: 4, verifiedDelivery: { ownerRouteId: 'owner-route', budgetId: 'delivery-budget', acceptance: 'goal-outcome' as const } }
    expect(createBrokerGrantProjection(authority).verifiedDelivery).toEqual(authority.verifiedDelivery)
    expect(() => createBrokerGrantProjection({ ...authority, allowedOperations: ['pull-request'] as const })).toThrowError(/requires commit/)
    expect(() => createBrokerGrantProjection({ ...authority, verifiedDelivery: { ...authority.verifiedDelivery, unexpected: true } as unknown as typeof authority.verifiedDelivery })).toThrowError(/unknown or missing/)
    const legacy = { ...authority, allowedOperations: ['commit'] as const, destination: { ...intent().destination, paths: ['src/file.txt'] } }
    delete (legacy as { verifiedDelivery?: unknown }).verifiedDelivery
    expect(createBrokerGrantProjection(legacy)).not.toHaveProperty('verifiedDelivery')
    expect(brokerGrantAuthorityDigest(legacy)).toBe(brokerDigest(legacy))
  })

  it('accepts only a signed response bound to the exact request and result target', () => {
    const signedHello = hello(), request = createBrokerClientRequest(intent(), signedHello, client, 'client-key-1', clientKeys.privateKey, 'request-1')
    const response = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'commit', repository: request.destination.repository, branch: request.destination.branch, parentOid: (request.payload as { expectedHeadOid: string }).expectedHeadOid, commitOid: 'e'.repeat(40) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)
    expect(verifyBrokerServerResponse(response, request, signedHello, serverKeys.publicKey)).toEqual(response)
    const other = createBrokerClientRequest({ ...intent(), callId: 'call-2' }, signedHello, client, 'client-key-1', clientKeys.privateKey, 'request-2')
    expect(() => verifyBrokerServerResponse(response, other, signedHello, serverKeys.publicKey)).toThrowError(/does not match|not bound/)
    expect(() => verifyBrokerServerResponse({ ...response, requestId: 'forged' }, request, signedHello, serverKeys.publicKey)).toThrowError(/not bound/)
    expect(canonicalBrokerJson(response)).not.toContain('token')
  })

  it('binds a pull-request request and result to its exact head and base scope', () => {
    const signedHello = hello()
    const request = createBrokerClientRequest({ ...intent(), operation: 'pull-request', destination: { ...intent().destination, baseBranch: 'stable' }, payload: { expectedHeadOid: 'd'.repeat(40), title: 'Deliver', body: 'trusted host will verify receipt' } }, signedHello, client, 'client-key-1', clientKeys.privateKey, 'pull-request')
    const result = { operation: 'pull-request' as const, repository: 'owner/repository', branch: 'main', baseBranch: 'stable', expectedHeadOid: 'd'.repeat(40), pullRequestNumber: 7 }
    const response = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)
    expect(verifyBrokerServerResponse(response, request, signedHello, serverKeys.publicKey).result).toEqual(result)
    expect(() => createBrokerClientRequest({ ...intent(), operation: 'pull-request', payload: { expectedHeadOid: 'd'.repeat(40), title: 'Deliver', body: '' } }, signedHello, client, 'client-key-1', clientKeys.privateKey)).toThrowError(/base branch/)
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { ...result, baseBranch: 'other' }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/target does not match/)
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { ...result, expectedHeadOid: 'e'.repeat(40) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/expected head/)
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { ...result, pullRequestNumber: 0 }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/pullRequestNumber/)
  })

  it('allows only the exact per-kind inspect response DTO', () => {
    const signedHello = hello()
    const inspectIntent: BrokerRequestIntent = { ...intent(), operation: 'inspect', payload: { kind: 'repository' } }
    const request = createBrokerClientRequest(inspectIntent, signedHello, client, 'client-key-1', clientKeys.privateKey, 'inspect-request')
    const observed = { full_name: request.destination.repository, untrusted: true as const }
    const response = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'repository', observed, observedDigest: brokerDigest(observed) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)
    expect(verifyBrokerServerResponse(response, request, signedHello, serverKeys.publicKey).result).toEqual(expect.objectContaining({ observed }))
    const extraField = { ...observed, private: true }
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'repository', observed: extraField as unknown as typeof observed, observedDigest: brokerDigest(extraField) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/unknown or missing/)
    const secretField = { full_name: request.destination.repository, untrusted: true, description: 'github_pat_secret' }
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'repository', observed: secretField as unknown as typeof observed, observedDigest: brokerDigest(secretField) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/unknown or missing/)
  })

  it('requires a currently live hello whenever a request is verified', () => {
    const signedHello = hello(), request = createBrokerClientRequest(intent(), signedHello, client, 'client-key-1', clientKeys.privateKey)
    expect(() => verifyBrokerClientRequest(request, signedHello, clientKeys.publicKey, { now: signedHello.expiresAt })).toThrowError(/hello expired/)
    const adminRequest = createBrokerAdminRequest({ operation: 'status', body: {}, deadline: now + 20_000 }, signedHello, admin, 'admin-key-1', adminKeys.privateKey)
    expect(() => verifyBrokerAdminRequest(adminRequest, signedHello, adminKeys.publicKey, { now: signedHello.expiresAt })).toThrowError(/hello expired/)
  })

  it('validates exact file, branch, pull-request, checks, reviews, and commit-checks DTOs with a precise scope', () => {
    const signedHello = hello()
    const cases: Array<{ payload: BrokerRequestIntent['payload']; observed: unknown }> = [
      { payload: { kind: 'branch' }, observed: { name: 'main', commit: { sha: 'e'.repeat(40) }, untrusted: true } },
      { payload: { kind: 'file', path: 'src/file.txt' }, observed: { path: 'src/file.txt', sha: 'e'.repeat(40), content: 'hello', untrusted: true } },
      { payload: { kind: 'pull-request', pullRequestNumber: 7 }, observed: { number: 7, state: 'open', merged: false, head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'base', repo: { full_name: 'owner/repository' } }, untrusted: true } },
      { payload: { kind: 'checks', pullRequestNumber: 7 }, observed: { pullRequest: { number: 7, state: 'open', merged: false, head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'base', repo: { full_name: 'owner/repository' } } }, headOid: 'e'.repeat(40), items: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: 'e'.repeat(40), app: { id: 2 } }], truncated: false, untrusted: true } },
      { payload: { kind: 'reviews', pullRequestNumber: 7 }, observed: { pullRequest: { number: 7, state: 'open', merged: false, head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'base', repo: { full_name: 'owner/repository' } } }, headOid: 'e'.repeat(40), items: [{ id: 1, state: 'APPROVED', commit_id: 'e'.repeat(40), user: { id: 2 }, submitted_at: '2026-09-12T00:00:00Z' }], truncated: false, untrusted: true } },
      { payload: { kind: 'commit-checks', commitOid: 'e'.repeat(40) }, observed: { repository: 'owner/repository', headOid: 'e'.repeat(40), items: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: 'e'.repeat(40), app: { id: 2 } }], truncated: false, untrusted: true } },
    ]
    for (const [index, item] of cases.entries()) {
      const request = createBrokerClientRequest({ ...intent(), destination: ['pull-request', 'checks', 'reviews'].includes((item.payload as { kind: string }).kind) ? { ...intent().destination, baseBranch: 'base' } : intent().destination, operation: 'inspect', payload: item.payload }, signedHello, client, 'client-key-1', clientKeys.privateKey, `inspect-${index}`)
      const response = createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: (item.payload as { kind: 'branch' }).kind, observed: item.observed as never, observedDigest: brokerDigest(item.observed) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)
      expect(verifyBrokerServerResponse(response, request, signedHello, serverKeys.publicKey).status).toBe('succeeded')
      expect(Object.isFrozen((response.result as { observed: object }).observed)).toBe(true)
    }
  })

  it('rejects pull-request inspection without an exact, distinct in-repository base branch', () => {
    const signedHello = hello()
    const pullRequest = { ...intent(), operation: 'inspect' as const, payload: { kind: 'pull-request' as const, pullRequestNumber: 7 } }
    expect(() => createBrokerClientRequest(pullRequest, signedHello, client, 'client-key-1', clientKeys.privateKey)).toThrowError(/base branch/)
    expect(() => createBrokerClientRequest({ ...pullRequest, destination: { ...intent().destination, baseBranch: 'main' } }, signedHello, client, 'client-key-1', clientKeys.privateKey)).toThrowError(/base branch/)
    const request = createBrokerClientRequest({ ...pullRequest, destination: { ...intent().destination, baseBranch: 'base' } }, signedHello, client, 'client-key-1', clientKeys.privateKey)
    const observed = { number: 7, state: 'open' as const, merged: false, head: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'fork/repository' } }, base: { ref: 'base', repo: { full_name: 'owner/repository' } }, untrusted: true as const }
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'pull-request', observed, observedDigest: brokerDigest(observed) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/scope does not match/)
    const wrongBase = { ...observed, head: { ...observed.head, repo: { full_name: 'owner/repository' } }, base: { ...observed.base, ref: 'other' } }
    expect(() => createBrokerServerResponse({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', repository: request.destination.repository, branch: request.destination.branch, kind: 'pull-request', observed: wrongBase, observedDigest: brokerDigest(wrongBase) }, error: null, completedAt: now + 2 }, request, signedHello, serverKeys.privateKey)).toThrowError(/scope does not match/)
  })

  it('rejects a frame whose request payload exceeds 8 MiB', () => {
    expect(() => encodeBrokerFrame({ body: 'x'.repeat(GITHUB_BROKER_REQUEST_MAX_BYTES) }, GITHUB_BROKER_REQUEST_MAX_BYTES)).toThrowError(/exceeds/)
  })
})

describe('broker admin authentication', () => {
  it('binds nonce and CAS control version for mutating admin operations', () => {
    const signedHello = hello()
    const request = createBrokerAdminRequest({ operation: 'stop', body: { expectedControlVersion: 4, drainDeadline: now + 5_000, reason: 'security-response' }, deadline: now + 8_000 }, signedHello, admin, 'admin-key-1', adminKeys.privateKey, 'admin-request-1', Buffer.alloc(32, 8).toString('base64url'))
    expect(verifyBrokerAdminRequest(request, signedHello, adminKeys.publicKey, { now, expectedAdminKeyId: 'admin-key-1' })).toEqual(request)
    expect(() => verifyBrokerAdminRequest({ ...request, nonce: Buffer.alloc(32, 9).toString('base64url') }, signedHello, adminKeys.publicKey, { now })).toThrowError(/signature verification/)
    expect(() => createBrokerAdminRequest({ operation: 'stop', body: { expectedControlVersion: 4, drainDeadline: now + 5_000, reason: 'other' as 'maintenance' }, deadline: now + 8_000 }, signedHello, admin, 'admin-key-1', adminKeys.privateKey)).toThrowError(/reason/)

    const response = createBrokerAdminResponse({ status: 'succeeded', state: { admission: 'stopped', generation: 11, controlVersion: 5, activeRequests: 0, revocationEpoch: 2 }, error: null, completedAt: now + 1 }, request, signedHello, serverKeys.privateKey)
    expect(verifyBrokerAdminResponse(response, request, signedHello, serverKeys.publicKey)).toEqual(response)
    expect(() => verifyBrokerAdminResponse({ ...response, state: { ...response.state, controlVersion: 6 } }, request, signedHello, serverKeys.publicKey)).toThrowError(/signature verification/)
  })
})
