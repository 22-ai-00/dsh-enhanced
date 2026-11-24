import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ACTION_BROKER_PROTOCOL,
  ACTION_GRANT_PROTOCOL,
  actionBrokerRequestDigest,
  createActionBrokerAdminRequest,
  createActionBrokerAdminResponse,
  createActionBrokerClientRequest,
  createActionBrokerServerHello,
  createActionBrokerServerResponse,
  createActionGrantProjection,
  normalizeActionGrantAuthority,
  normalizeActionGrantProjection,
  validateBrokerActionRequest,
  verifyActionBrokerAdminRequest,
  verifyActionBrokerAdminResponse,
  verifyActionBrokerClientRequest,
  verifyActionBrokerServerHello,
  verifyActionBrokerServerResponse,
  type ActionBrokerGrantAuthorityUnsigned,
} from '../src/broker-protocol.ts'

const serverKeys = generateKeyPairSync('ed25519')
const clientKeys = generateKeyPairSync('ed25519')
const adminKeys = generateKeyPairSync('ed25519')
const now = 1_700_000_000_000

function sampleGrant(): ActionBrokerGrantAuthorityUnsigned {
  return {
    protocol: ACTION_GRANT_PROTOCOL,
    id: 'grant-http-v2',
    revision: 1,
    domain: 'http',
    clientKeyId: 'host-key-1',
    owner: {
      principalDigest: 'a'.repeat(64),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: '/workspace',
      preset: 'primary',
      bindingId: 'binding-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    },
    sessionId: 'session-1',
    destination: {
      classification: 'http-endpoint',
      allowedSchemes: ['https'],
      allowedHosts: ['api.example.test'],
      allowedMethods: ['GET', 'POST'],
      allowedPathPrefixes: ['/v1/'],
      allowRedirects: false,
      maxResponseBytes: 65_536,
    },
    credentialId: 'cred-http',
    expiresAt: now + 60_000,
    maxActions: 10,
    maxTotalBytes: 1_048_576,
    maxCostUnits: 10,
    allowedOperations: ['http.request'],
    client: { kind: 'assistant-actions-host', instanceId: 'host-1', generation: 1 },
    source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
    policyEpoch: 2,
    emergencyEpoch: 0,
    lease: { leaseId: 'lease-1', expiresAtMs: now + 60_000, maxUses: 3 },
    destinations: ['https://api.example.test/v1/*'],
    maxSensitivity: 'internal',
    monetaryCostCapMicros: 500,
    commitDigest: 'c'.repeat(64),
  }
}

describe('Action Broker Protocol v2 (broker-protocol-v2.ts)', () => {
  it('signs and verifies v2 server hello, client request, server response, and admin frames', () => {
    const grant = normalizeActionGrantAuthority(sampleGrant())
    const projection = normalizeActionGrantProjection(createActionGrantProjection(grant))
    expect(projection.protocol).toBe(ACTION_GRANT_PROTOCOL)
    expect(projection.lease?.maxUses).toBe(3)

    const hello = createActionBrokerServerHello({
      instanceId: 'broker-v2',
      generation: 1,
      policyEpoch: 2,
      emergencyEpoch: 0,
      expiresAt: now + 30_000,
    }, serverKeys.privateKey)
    const verifiedHello = verifyActionBrokerServerHello(hello, serverKeys.publicKey, { now, expectedInstanceId: 'broker-v2', minimumGeneration: 1 })
    expect(verifiedHello.protocol).toBe(ACTION_BROKER_PROTOCOL)

    const req = createActionBrokerClientRequest({
      actionId: 'act-1',
      grantId: grant.id,
      grantRevision: grant.revision,
      grantDigest: projection.grantDigest,
      domain: 'http',
      owner: grant.owner,
      sessionId: grant.sessionId,
      agentId: 'agent-1',
      rootCallId: 'root-1',
      callId: 'call-1',
      operation: 'http.request',
      source: grant.source,
      destination: { classification: 'http-endpoint', scheme: 'https', host: 'api.example.test', path: '/v1/items' },
      payload: { method: 'GET', url: 'https://api.example.test/v1/items' },
      deadline: now + 15_000,
      budget: { reservationId: 'res-1', actions: 1, bytes: 50, costMetric: 'http-requests', maxCostUnits: 1, estimatedCostMicros: 100 },
      estimatedCostMicros: 100,
      commitDigest: 'c'.repeat(64),
      idempotencyKey: 'idem-1',
    }, verifiedHello, grant.client, grant.clientKeyId, clientKeys.privateKey, 'req-1')

    const verifiedReq = verifyActionBrokerClientRequest(req, verifiedHello, clientKeys.publicKey, { now, expectedClientKeyId: grant.clientKeyId })
    expect(actionBrokerRequestDigest(verifiedReq)).toMatch(/^[0-9a-f]{64}$/)

    const res = createActionBrokerServerResponse({
      status: 'succeeded',
      dispatched: true,
      result: {
        domain: 'http',
        operation: 'http.request',
        statusCode: 200,
        responseHeaders: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        bodySha256: 'd'.repeat(64),
        truncated: false,
        untrusted: true,
      },
      error: null,
      completedAt: now + 100,
    }, verifiedReq, verifiedHello, serverKeys.privateKey)

    const verifiedRes = verifyActionBrokerServerResponse(res, verifiedReq, verifiedHello, serverKeys.publicKey)
    expect(verifiedRes.status).toBe('succeeded')

    const adminReq = createActionBrokerAdminRequest(
      { operation: 'status', body: {}, deadline: now + 10_000 },
      verifiedHello,
      { kind: 'assistant-actions-admin', instanceId: 'admin-1', generation: 1 },
      'admin-key',
      adminKeys.privateKey,
    )
    const verifiedAdminReq = verifyActionBrokerAdminRequest(adminReq, verifiedHello, adminKeys.publicKey, { now, expectedAdminKeyId: 'admin-key' })
    const adminRes = createActionBrokerAdminResponse({
      status: 'succeeded',
      state: { admission: 'accepting', generation: 1, controlVersion: 0, activeRequests: 0, revocationEpoch: 0 },
      error: null,
      completedAt: now + 50,
    }, verifiedAdminReq, verifiedHello, serverKeys.privateKey)
    const verifiedAdminRes = verifyActionBrokerAdminResponse(adminRes, verifiedAdminReq, verifiedHello, serverKeys.publicKey)
    expect(verifiedAdminRes.state.admission).toBe('accepting')
  })

  it('validates opaque-box broker action envelopes for http, lark, calendar, and shell', () => {
    expect(validateBrokerActionRequest({
      kind: 'http', operation: 'fetch', destination: 'https://api.example.test/health', method: 'GET', grantId: 'g1', idempotencyKey: 'k1',
    }).kind).toBe('http')
    expect(validateBrokerActionRequest({
      kind: 'lark', operation: 'send-message', chatId: 'oc_1', text: 'ok', grantId: 'g2', idempotencyKey: 'k2',
    }).kind).toBe('lark')
    expect(validateBrokerActionRequest({
      kind: 'calendar', operation: 'list-events', calendarId: 'cal-1', startTime: 100, endTime: 200, grantId: 'g3', idempotencyKey: 'k3',
    }).kind).toBe('calendar')
    expect(validateBrokerActionRequest({
      kind: 'shell', operation: 'exec', command: ['/bin/echo', 'hi'], cwd: '/workspace', grantId: 'g4', idempotencyKey: 'k4',
    }).kind).toBe('shell')
    expect(() => validateBrokerActionRequest({
      kind: 'http', operation: 'fetch', destination: 'https://user:pass@api.example.test/health', method: 'GET', grantId: 'g1', idempotencyKey: 'k1',
    })).toThrow()
    for (const badUrl of [
      'https://example.com/a/../b',
      'https://example.com/%2e%2e/b',
      'https://example.com/a/./b',
      'https://example.com/%2f/b',
      'https://example.com/%5c/b',
    ]) {
      expect(() => validateBrokerActionRequest({
        kind: 'http', operation: 'fetch', destination: badUrl, method: 'GET', grantId: 'g1', idempotencyKey: 'k1',
      })).toThrow()
    }
    expect(validateBrokerActionRequest({
      kind: 'http', operation: 'fetch', destination: 'https://example.com/@me', method: 'GET', grantId: 'g1', idempotencyKey: 'k1',
    }).kind).toBe('http')
  })

  it('accepts canonical POSIX and Windows workspaces across v2 grants and envelopes while rejecting invalid paths', () => {
    for (const validWorkspace of ['/workspace', 'C:\\workspace']) {
      const base = sampleGrant()
      const normalized = normalizeActionGrantAuthority({
        ...base,
        owner: { ...base.owner, workspace: validWorkspace },
      })
      expect(normalized.owner.workspace).toBe(validWorkspace)
      const httpEnv = validateBrokerActionRequest({
        kind: 'http', operation: 'fetch', destination: 'https://api.example.test/health', method: 'GET', workspace: validWorkspace, grantId: 'g1', idempotencyKey: 'k1',
      })
      expect(httpEnv.kind === 'http' && httpEnv.workspace).toBe(validWorkspace)
    }
    expect(validateBrokerActionRequest({
      kind: 'shell', operation: 'exec', command: ['C:\\Windows\\System32\\cmd.exe', '/c', 'echo'], cwd: 'C:\\workspace', grantId: 'g5', idempotencyKey: 'k5',
    }).kind).toBe('shell')

    for (const invalidWorkspace of ['/', 'C:\\', 'C:/workspace', 'C:\\workspace\\', '\\\\server\\share\\dir', '/workspace/', '/workspace/../etc', 'workspace']) {
      const base = sampleGrant()
      expect(() => normalizeActionGrantAuthority({
        ...base,
        owner: { ...base.owner, workspace: invalidWorkspace },
      })).toThrowError(/workspace is invalid/)
      expect(() => validateBrokerActionRequest({
        kind: 'http', operation: 'fetch', destination: 'https://api.example.test/health', method: 'GET', workspace: invalidWorkspace, grantId: 'g1', idempotencyKey: 'k1',
      })).toThrowError(/invalid http workspace/)
    }
  })
})
