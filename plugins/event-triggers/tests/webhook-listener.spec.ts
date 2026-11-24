import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, Agent } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { parseExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { afterEach, describe, expect, test } from 'vitest'
import { EVENT_OBSERVER_EXECUTOR } from '../src/observer.ts'
import { EventTriggersService } from '../src/service.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createWebhookListenerHarness(options: {
  host?: string
  initialNow?: number
  maxBodyBytes?: number
  maxConcurrentRequests?: number
  drainTimeoutMs?: number
  denyPolicyForTrigger?: string
  credentialLease?: { leaseId: string; maxUses: number; expiresAtMs?: number }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-webhook-http-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: () => Object.freeze({
      authorityId: 'route-1',
      authorityHash: 'a'.repeat(64),
      receiptVersion: 2 as const,
      principalId: 'owner:one',
      principalRecordId: 'record-1',
      principalVersion: 1,
      workspace: root,
      agentPreset: 'primary',
      bindingVersion: 1,
      generation: 1,
    }),
  } as never)
  const observer = {
    workspace: root,
    preset: 'primary',
    principalId: 'owner:one',
    principalRecordId: 'record-1',
    principalVersion: 1,
    ownerRouteId: 'route-1',
    expiresAt: Date.now() + 120_000,
    budgetId: 'webhook-obs',
  }
  const rules: Array<{
    id: string
    effect: 'allow' | 'deny'
    subject: { kind: 'background' | 'external'; id: string; workspace?: string; principal?: string }
    actions: string[]
    resource: { kind: 'credential' | 'automation'; id: string }
    context: { initiators: Array<'background' | 'external'> }
    lease?: { leaseId: string; maxUses: number; expiresAtMs?: number }
  }> = [
    {
      id: 'observer', effect: 'allow',
      subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' },
      actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' },
      context: { initiators: ['background'] },
    },
    {
      id: 'cred-use', effect: 'allow',
      subject: { kind: 'background', id: 'dsh-enhanced-event-triggers' },
      actions: ['credential.use'], resource: { kind: 'credential', id: '*' },
      context: { initiators: ['background'] },
      ...(options.credentialLease === undefined ? {} : { lease: options.credentialLease }),
    },
    {
      id: 'ingest-all', effect: 'allow',
      subject: { kind: 'external', id: '*', workspace: root },
      actions: ['ingest'], resource: { kind: 'automation', id: '*' },
      context: { initiators: ['external'] },
    },
  ]
  for (const id of ['hmac-hook', 'bearer-hook', 'secret-hook']) {
    rules.push({
      id: `accept-${id}`,
      effect: options.denyPolicyForTrigger === id ? 'deny' : 'allow',
      subject: { kind: 'external', id: `webhook:${id}` },
      actions: ['accept'],
      resource: { kind: 'automation', id: '*' },
      context: { initiators: ['external'] },
    })
  }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules })
  const automations = await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'),
    runsPath: join(root, 'runs'),
    schedulerEnabled: false,
    reconcileIntervalMs: 0,
    allowUnbudgetedExecution: true,
  })
  await ctx.plugin({
    name: 'webhook-creds',
    apply(runtime: Context) {
      new CredentialsKeychainService(runtime, {
        databasePath: join(root, 'credentials.sqlite'),
        handles: [
          {
            id: 'hook-secret', provider: 'environment', environmentName: 'WEBHOOK_SECRET',
            consumers: ['dsh-enhanced-event-triggers'], purposes: ['verify-webhook'], maxLeaseMs: 30_000,
          },
        ],
      }, { env: { WEBHOOK_SECRET: 'super-secret-value-never-leak' } })
    },
  })

  let now = options.initialNow ?? 100_000
  let service!: EventTriggersService
  await ctx.plugin({
    name: 'dsh-enhanced-event-triggers',
    apply(runtime: Context) {
      service = new EventTriggersService(runtime, {
        databasePath: join(root, 'events.sqlite'),
        pollerEnabled: false,
        maxBodyBytes: options.maxBodyBytes ?? 1_024,
        requestTimeoutMs: 2_000,
        webhookListen: {
          enabled: true,
          host: options.host ?? '127.0.0.1',
          port: 0,
          basePath: '/webhooks',
          maxConcurrentRequests: options.maxConcurrentRequests ?? 16,
          drainTimeoutMs: options.drainTimeoutMs ?? 500,
        },
        triggers: [
          {
            id: 'hmac-hook', kind: 'webhook', automationId: 'auto-hmac',
            credentialHandle: 'hook-secret', maxSkewMs: 60_000, cooldownMs: 5_000, maxFires: 2, observer,
          },
          {
            id: 'bearer-hook', kind: 'webhook', automationId: 'auto-bearer',
            credentialHandle: 'hook-secret', path: '/custom/bearer', authMode: 'bearer',
            maxSkewMs: 60_000, cooldownMs: 0, maxFires: 10, observer,
          },
          {
            id: 'secret-hook', kind: 'webhook', automationId: 'auto-secret',
            credentialHandle: 'hook-secret', authMode: 'shared-secret', secretHeader: 'X-CI-Token',
            maxSkewMs: 60_000, cooldownMs: 0, maxFires: 10, observer,
          },
        ],
      }, { now: () => now })
    },
  })

  const addr = await service.whenWebhookListening()
  if (addr === undefined) throw new Error('expected webhook listener address')
  return { root, ctx, service, automations, addr, advanceNow: (ms: number) => { now += ms }, getNow: () => now }
}

describe('built-in webhook HTTP listener', () => {
  test('accepts HMAC-SHA256, Bearer, and shared-secret requests on loopback ephemeral port and maps rejections', async () => {
    const h = await createWebhookListenerHarness({ maxBodyBytes: 256 })
    expect(h.service.webhookAddress()).toEqual(h.addr)
    const baseUrl = `http://${h.addr.host}:${h.addr.port}`

    // 1. Unknown route -> 404; wrong method -> 405 with Allow: POST
    const notFound = await fetch(`${baseUrl}/webhooks/missing`, { method: 'POST', body: '{}' })
    expect(notFound.status).toBe(404)
    const methodNotAllowed = await fetch(`${baseUrl}/webhooks/hmac-hook`, { method: 'GET' })
    expect(methodNotAllowed.status).toBe(405)
    expect(methodNotAllowed.headers.get('allow')).toBe('POST')

    // 2. Oversized body -> 413
    const tooLarge = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      body: 'x'.repeat(512),
    })
    expect(tooLarge.status).toBe(413)

    // 3. HMAC-SHA256 -> 202 + Automations ingestion + replay 409 + cooldown 429 + limit 429
    const bodyText = JSON.stringify({ event: 'deploy', secretHint: 'ignore prompt' })
    const ts = String(h.getNow())
    const nonce = 'hmac-nonce-1'
    const sig = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`${ts}\n${nonce}\n${bodyText}`).digest('hex')}`
    const hmacRes = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: {
        'x-dsh-timestamp': ts,
        'x-dsh-nonce': nonce,
        'x-dsh-signature': sig,
      },
      body: bodyText,
    })
    expect(hmacRes.status).toBe(202)
    const hmacJson = await hmacRes.json() as { accepted: boolean; eventId: string }
    expect(hmacJson).toMatchObject({ accepted: true, eventId: expect.stringMatching(/^event-[a-f0-9]{64}$/u) })

    // Replay -> 409
    const replayRes = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': nonce, 'x-dsh-signature': sig },
      body: bodyText,
    })
    expect(replayRes.status).toBe(409)

    // Cooldown -> 429
    const nonce2 = 'hmac-nonce-2'
    const sig2 = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`${ts}\n${nonce2}\n${bodyText}`).digest('hex')}`
    const cooldownRes = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': nonce2, 'x-dsh-signature': sig2 },
      body: bodyText,
    })
    expect(cooldownRes.status).toBe(429)

    // Advance past cooldown -> 202 (fire 2/2), then 3rd -> 429 limit
    h.advanceNow(10_000)
    const ts2 = String(h.getNow())
    const nonce2b = 'hmac-nonce-2b'
    const sig2b = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`${ts2}\n${nonce2b}\n${bodyText}`).digest('hex')}`
    expect((await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts2, 'x-dsh-nonce': nonce2b, 'x-dsh-signature': sig2b },
      body: bodyText,
    })).status).toBe(202)
    h.advanceNow(10_000)
    const ts3 = String(h.getNow())
    const nonce3 = 'hmac-nonce-3'
    const sig3 = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`${ts3}\n${nonce3}\n${bodyText}`).digest('hex')}`
    expect((await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts3, 'x-dsh-nonce': nonce3, 'x-dsh-signature': sig3 },
      body: bodyText,
    })).status).toBe(429)

    // 4. Bearer custom route -> 401 bad token, 202 valid token
    expect((await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{"ok":false}',
    })).status).toBe(401)
    const bearerRes = await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak', 'x-dsh-nonce': 'bearer-1' },
      body: '{"ok":true}',
    })
    expect(bearerRes.status).toBe(202)

    // 5. Shared-secret custom header -> 401 missing/wrong, 202 valid
    expect((await fetch(`${baseUrl}/webhooks/secret-hook`, {
      method: 'POST',
      headers: { 'x-ci-token': 'bad' },
      body: '{}',
    })).status).toBe(401)
    const secretRes = await fetch(`${baseUrl}/webhooks/secret-hook`, {
      method: 'POST',
      headers: { 'x-ci-token': 'super-secret-value-never-leak', 'x-webhook-id': 'ci-run-77' },
      body: '{"status":"green"}',
    })
    expect(secretRes.status).toBe(202)

    // Verify delivered outbox & zero secret leakage
    expect(h.service.health()).toMatchObject({ deliveredEvents: 4, pendingEvents: 0 })
    const snapshot = h.service.sourceSnapshot('bearer-hook')
    expect(snapshot.kind).toBe('webhook')
    const outboxEv = h.service.firstEventAfter(
      { ...snapshot, highWaterSequence: 0 },
      0,
      h.getNow() + 60_000,
    )
    expect(outboxEv).toBeDefined()
    const parsed = parseExternalEventEnvelope(outboxEv!.envelope)
    expect(parsed.trust.method).toBe('hmac-sha256')
    expect(parsed.observation.timeBasis).toBe('source-signed')
    expect(JSON.stringify(parsed)).not.toContain('super-secret-value-never-leak')
  })

  test('maps policy-denied webhook requests to 403 without exposing secrets', async () => {
    const h = await createWebhookListenerHarness({ denyPolicyForTrigger: 'bearer-hook' })
    const res = await fetch(`http://${h.addr.host}:${h.addr.port}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak' },
      body: '{"action":"run"}',
    })
    expect(res.status).toBe(403)
    const bodyText = await res.text()
    expect(bodyText).not.toContain('super-secret-value-never-leak')
    expect(bodyText).not.toContain('hook-secret')
  })

  test('maps exhausted credential lease policy-denied errors to 403 without leaking secrets', async () => {
    const h = await createWebhookListenerHarness({
      credentialLease: { leaseId: 'lease-webhook-1', maxUses: 1 },
    })
    const first = await fetch(`http://${h.addr.host}:${h.addr.port}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak' },
      body: '{"action":"first"}',
    })
    expect(first.status).toBe(202)

    const second = await fetch(`http://${h.addr.host}:${h.addr.port}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak' },
      body: '{"action":"second"}',
    })
    expect(second.status).toBe(403)
    const payload = await second.text()
    expect(JSON.parse(payload)).toEqual({ error: 'policy-denied' })
    expect(payload).not.toContain('super-secret-value-never-leak')
    expect(payload).not.toContain('hook-secret')
  })

  test('preserves exact configDigest for legacy webhook triggers without listener options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-webhook-digest-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
      schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true,
    })
    await ctx.plugin({
      name: 'webhook-creds-digest',
      apply(runtime: Context) {
        new CredentialsKeychainService(runtime, {
          databasePath: join(root, 'credentials.sqlite'),
          handles: [{
            id: 'hook-secret', provider: 'environment', environmentName: 'WEBHOOK_SECRET',
            consumers: ['dsh-enhanced-event-triggers'], purposes: ['verify-webhook'], maxLeaseMs: 30_000,
          }],
        }, { env: { WEBHOOK_SECRET: 's' } })
      },
    })
    const svc1 = new EventTriggersService(ctx, {
      databasePath: join(root, 'events1.sqlite'),
      pollerEnabled: false,
      triggers: [{ id: 'hook', kind: 'webhook', automationId: 'auto-1', credentialHandle: 'hook-secret' }],
    })
    const digestWithoutListen = svc1.sourceSnapshot('hook').configDigest
    await ctx.fiber.restart()

    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(AssistantPolicyService, { databasePath: join(root, 'policy2.sqlite'), rules: [] })
    await ctx2.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations2.sqlite'), runsPath: join(root, 'runs2'),
      schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true,
    })
    await ctx2.plugin({
      name: 'webhook-creds-digest-2',
      apply(runtime: Context) {
        new CredentialsKeychainService(runtime, {
          databasePath: join(root, 'credentials2.sqlite'),
          handles: [{
            id: 'hook-secret', provider: 'environment', environmentName: 'WEBHOOK_SECRET',
            consumers: ['dsh-enhanced-event-triggers'], purposes: ['verify-webhook'], maxLeaseMs: 30_000,
          }],
        }, { env: { WEBHOOK_SECRET: 's' } })
      },
    })
    const svc2 = new EventTriggersService(ctx2, {
      databasePath: join(root, 'events2.sqlite'),
      pollerEnabled: false,
      webhookListen: { enabled: true, host: '127.0.0.1', port: 0 },
      triggers: [{ id: 'hook', kind: 'webhook', automationId: 'auto-1', credentialHandle: 'hook-secret', authMode: 'hmac-sha256' }],
    })
    expect(svc2.sourceSnapshot('hook').configDigest).toBe(digestWithoutListen)
  })

  test('drains keep-alive connections and closes listener cleanly on ctx.fiber.restart()', async () => {
    const h = await createWebhookListenerHarness({ drainTimeoutMs: 150 })
    const agent = new Agent({ keepAlive: true, maxSockets: 2 })
    try {
      const status = await new Promise<number>((resolveStatus, rejectStatus) => {
        const req = httpRequest({
          host: h.addr.host,
          port: h.addr.port,
          path: '/custom/bearer',
          method: 'POST',
          agent,
          headers: { authorization: 'Bearer super-secret-value-never-leak', 'content-length': '2' },
        }, res => {
          res.resume()
          res.on('end', () => resolveStatus(res.statusCode ?? 0))
        })
        req.on('error', rejectStatus)
        req.end('{}')
      })
      expect(status).toBe(202)

      // Restart while keep-alive socket is idle; must not hang beyond drainTimeoutMs
      const start = Date.now()
      await h.ctx.fiber.restart()
      expect(Date.now() - start).toBeLessThan(2_000)

      // Port is now closed
      await expect(fetch(`http://${h.addr.host}:${h.addr.port}/custom/bearer`, { method: 'POST', body: '{}' }))
        .rejects.toThrow()
    } finally {
      agent.destroy()
    }
  })

  test('returns HTTP 413 with Connection: close for oversized multi-chunk and single-chunk transfer-encoding bodies', async () => {
    const h = await createWebhookListenerHarness({ maxBodyBytes: 64 })
    const sendRaw = (payload: string): Promise<string> => new Promise((resolveResponse, rejectResponse) => {
      const socket = netConnect({ host: h.addr.host, port: h.addr.port })
      const chunks: Buffer[] = []
      socket.setTimeout(2_000)
      socket.on('connect', () => {
        socket.write(payload)
      })
      socket.on('data', chunk => chunks.push(chunk))
      socket.on('end', () => resolveResponse(Buffer.concat(chunks).toString('utf8')))
      socket.on('timeout', () => {
        socket.destroy()
        rejectResponse(new Error('raw TCP request timed out'))
      })
      socket.on('error', (error) => {
        if (chunks.length > 0) {
          resolveResponse(Buffer.concat(chunks).toString('utf8'))
        } else {
          rejectResponse(error)
        }
      })
    })

    // Multi-chunk body (3 x 30 = 90 bytes > 64)
    const c30 = 'a'.repeat(30)
    const hex30 = (30).toString(16)
    const multiChunkReq = [
      'POST /webhooks/hmac-hook HTTP/1.1',
      `Host: ${h.addr.host}:${h.addr.port}`,
      'Transfer-Encoding: chunked',
      '',
      `${hex30}\r\n${c30}\r\n${hex30}\r\n${c30}\r\n${hex30}\r\n${c30}\r\n0\r\n\r\n`,
    ].join('\r\n')
    const multiResp = await sendRaw(multiChunkReq)
    expect(multiResp).toContain('HTTP/1.1 413')
    expect(multiResp.toLowerCase()).toContain('connection: close')
    expect(multiResp).toContain('{"error":"payload-too-large"}')

    // Single oversized chunk (100 bytes > 64)
    const c100 = 'b'.repeat(100)
    const hex100 = (100).toString(16)
    const singleChunkReq = [
      'POST /webhooks/hmac-hook HTTP/1.1',
      `Host: ${h.addr.host}:${h.addr.port}`,
      'Transfer-Encoding: chunked',
      '',
      `${hex100}\r\n${c100}\r\n0\r\n\r\n`,
    ].join('\r\n')
    const singleResp = await sendRaw(singleChunkReq)
    expect(singleResp).toContain('HTTP/1.1 413')
    expect(singleResp.toLowerCase()).toContain('connection: close')
    expect(singleResp).toContain('{"error":"payload-too-large"}')

    // Streaming http.request without Content-Length
    const streamed = await new Promise<{ status: number; body: string }>((resolveStream, rejectStream) => {
      const req = httpRequest({
        host: h.addr.host,
        port: h.addr.port,
        path: '/webhooks/hmac-hook',
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' },
      }, res => {
        const parts: Buffer[] = []
        res.on('data', d => parts.push(d))
        res.on('end', () => resolveStream({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }))
      })
      req.on('error', rejectStream)
      req.write('c'.repeat(40))
      req.write('d'.repeat(40))
      req.end()
    })
    expect(streamed.status).toBe(413)
    expect(JSON.parse(streamed.body)).toEqual({ error: 'payload-too-large' })
  })

  test('detects duplicate raw headers (including authorization) and rejects malformed request URLs', async () => {
    const h = await createWebhookListenerHarness()
    const sendRaw = (rawRequest: string): Promise<{ statusLine: string; body: string }> => new Promise((resolveResp, rejectResp) => {
      const socket = netConnect({ host: h.addr.host, port: h.addr.port })
      const chunks: Buffer[] = []
      socket.setTimeout(2_000)
      socket.on('connect', () => socket.end(rawRequest))
      socket.on('data', chunk => chunks.push(chunk))
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const [head, body = ''] = text.split('\r\n\r\n')
        resolveResp({ statusLine: head!.split('\r\n')[0]!, body })
      })
      socket.on('timeout', () => {
        socket.destroy()
        rejectResp(new Error('raw TCP request timed out'))
      })
      socket.on('error', rejectResp)
    })

    // Duplicate authorization headers -> 400 malformed-headers (NOT 202!)
    const dupAuth = await sendRaw([
      'POST /custom/bearer HTTP/1.1',
      `Host: ${h.addr.host}:${h.addr.port}`,
      'Connection: close',
      'Authorization: Bearer super-secret-value-never-leak',
      'Authorization: Bearer other-token',
      'Content-Length: 2',
      '',
      '{}',
    ].join('\r\n'))
    expect(dupAuth.statusLine).toContain('400')
    expect(JSON.parse(dupAuth.body)).toEqual({ error: 'malformed-headers' })

    // Duplicate custom headers on HMAC and shared-secret routes -> 400 malformed-headers
    for (const reqText of [
      [
        'POST /webhooks/hmac-hook HTTP/1.1',
        `Host: ${h.addr.host}:${h.addr.port}`,
        'Connection: close',
        `x-dsh-timestamp: ${h.getNow()}`,
        'x-dsh-nonce: n-1',
        'x-dsh-signature: sha256=' + 'a'.repeat(64),
        'X-DSH-Signature: sha256=' + 'b'.repeat(64),
        'Content-Length: 2',
        '',
        '{}',
      ].join('\r\n'),
      [
        'POST /webhooks/hmac-hook HTTP/1.1',
        `Host: ${h.addr.host}:${h.addr.port}`,
        'Connection: close',
        `x-dsh-timestamp: ${h.getNow()}`,
        `x-dsh-timestamp: ${h.getNow()}`,
        'x-dsh-nonce: n-2',
        'x-dsh-signature: sha256=' + 'a'.repeat(64),
        'Content-Length: 2',
        '',
        '{}',
      ].join('\r\n'),
      [
        'POST /webhooks/secret-hook HTTP/1.1',
        `Host: ${h.addr.host}:${h.addr.port}`,
        'Connection: close',
        'X-CI-Token: super-secret-value-never-leak',
        'x-ci-token: wrong',
        'Content-Length: 2',
        '',
        '{}',
      ].join('\r\n'),
      [
        'POST /webhooks/secret-hook HTTP/1.1',
        `Host: ${h.addr.host}:${h.addr.port}`,
        'Connection: close',
        'X-CI-Token: super-secret-value-never-leak',
        'X-Webhook-Id: id-1',
        'x-webhook-id: id-2',
        'Content-Length: 2',
        '',
        '{}',
      ].join('\r\n'),
    ]) {
      const resp = await sendRaw(reqText)
      expect(resp.statusLine).toContain('400')
      expect(JSON.parse(resp.body)).toEqual({ error: 'malformed-headers' })
    }

    // Protocol-relative and dot-segment URLs -> 400 invalid-url
    for (const target of [
      '//evil.com/webhooks/hmac-hook',
      '/webhooks/other/../hmac-hook',
      '/webhooks/./hmac-hook',
      '/webhooks/other/%2e%2e/hmac-hook',
      '/\\evil.com/webhooks/hmac-hook',
    ]) {
      const resp = await sendRaw([
        `POST ${target} HTTP/1.1`,
        `Host: ${h.addr.host}:${h.addr.port}`,
        'Connection: close',
        'Content-Length: 2',
        '',
        '{}',
      ].join('\r\n'))
      expect(resp.statusLine).toContain('400')
      expect(JSON.parse(resp.body)).toEqual({ error: 'invalid-url' })
    }
  })

  test('prevents unauthenticated nonce replay oracle and rejects negative timestamps under small clocks', async () => {
    const h = await createWebhookListenerHarness({ initialNow: 10_000 })
    const baseUrl = `http://${h.addr.host}:${h.addr.port}`
    const body = '{}'
    const ts = String(h.getNow())

    // Accept valid HMAC event
    const hmacNonce = 'oracle-hmac-1'
    const validSig = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`${ts}\n${hmacNonce}\n${body}`).digest('hex')}`
    expect((await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': hmacNonce, 'x-dsh-signature': validSig },
      body,
    })).status).toBe(202)

    // Unauthenticated replay probe with invalid HMAC -> 401 (never 409)
    const badHmacReplay = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': hmacNonce, 'x-dsh-signature': `sha256=${'f'.repeat(64)}` },
      body,
    })
    expect(badHmacReplay.status).toBe(401)
    expect(await badHmacReplay.json()).toEqual({ error: 'invalid-signature' })

    // Authenticated replay -> 409
    expect((await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': ts, 'x-dsh-nonce': hmacNonce, 'x-dsh-signature': validSig },
      body,
    })).status).toBe(409)

    // Accept valid Bearer event
    const bearerNonce = 'oracle-bearer-1'
    expect((await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak', 'x-dsh-nonce': bearerNonce },
      body,
    })).status).toBe(202)

    // Unauthenticated Bearer probe with wrong token + known nonce -> 401
    const badBearerReplay = await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer WRONG', 'x-dsh-nonce': bearerNonce },
      body,
    })
    expect(badBearerReplay.status).toBe(401)
    expect(await badBearerReplay.json()).toEqual({ error: 'invalid-signature' })

    // Authenticated Bearer replay -> 409
    expect((await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak', 'x-dsh-nonce': bearerNonce },
      body,
    })).status).toBe(409)

    // Negative x-dsh-timestamp under small synthetic clock (< maxSkewMs) -> 401 timestamp
    const negBearer = await fetch(`${baseUrl}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak', 'x-dsh-timestamp': '-5' },
      body,
    })
    expect(negBearer.status).toBe(401)
    expect(await negBearer.json()).toEqual({ error: 'timestamp' })

    const negHmacSig = `sha256=${createHmac('sha256', 'super-secret-value-never-leak').update(`-5\nneg-ts-1\n${body}`).digest('hex')}`
    const negHmac = await fetch(`${baseUrl}/webhooks/hmac-hook`, {
      method: 'POST',
      headers: { 'x-dsh-timestamp': '-5', 'x-dsh-nonce': 'neg-ts-1', 'x-dsh-signature': negHmacSig },
      body,
    })
    expect(negHmac.status).toBe(401)
    expect(await negHmac.json()).toEqual({ error: 'timestamp' })
  })

  test('binds cleanly when configured with bracketed IPv6 loopback host [::1]', async () => {
    const h = await createWebhookListenerHarness({ host: '[::1]' })
    expect(h.addr.host).toBe('::1')
    expect(h.addr.port).toBeGreaterThan(0)
    const res = await fetch(`http://[${h.addr.host}]:${h.addr.port}/custom/bearer`, {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-value-never-leak', 'x-dsh-nonce': 'ipv6-1' },
      body: '{"ipv6":true}',
    })
    expect(res.status).toBe(202)
  })
})
