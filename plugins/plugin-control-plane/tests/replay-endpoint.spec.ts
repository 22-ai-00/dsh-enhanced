import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test as nativeTest, vi } from 'vitest'
import { installReplayEndpoint, queryReplayEndpoint, type ReplayEndpointConfig, type ReplayFixedAuthority } from '../src/replay-endpoint.js'
import { replayGrantSigningPayload, type ReplayGrant, type ReplaySignedAuthority } from '../src/replay-grant.js'
import { hostAttestationRequestDigest } from '../src/attestation.js'
import type { HostAttestationRequest } from '../src/types.js'
import { runtimeConfigDigest } from '../src/runtime-observer.js'
import { ReplayJournal } from '../src/replay-journal.js'
import { PluginControlPlaneService } from '../src/service.js'
import { assertReplayEndpointRequest, assertReplayEndpointResponse, validateReplayEndpointConfig } from '../src/replay-endpoint-protocol.js'

const test = nativeTest.skipIf(process.platform !== 'linux')
const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0).reverse()) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'replay-endpoint-'))
  const ctx = new Context(); fixtures.push({ ctx, root })
  const owner = join(root, 'owner'), profile = join(root, 'profile')
  await mkdir(owner, { mode: 0o700 }); await chmod(owner, 0o700); await mkdir(profile)
  const keyPath = join(owner, 'replay.key')
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const candidate = join(profile, 'candidate.js')
  await writeFile(join(profile, 'package.json'), '{"type":"module"}')
  await writeFile(candidate, "export default { name: 'candidate', apply(ctx) { ctx.provide('replayCandidate', {}) } }\n")
  const config: ReplayEndpointConfig & { authority: ReplayFixedAuthority } = {
    runtime: { socketPath: join(owner, 'replay.sock'), keyPath, profilePath: profile,
      targets: [{ entryId: 'candidate', module: './candidate.js', configDigest: runtimeConfigDigest({}), services: ['replayCandidate'] }] },
    journalPath: join(owner, 'replay.sqlite'), timeoutMs: 5000,
    authority: { operationId: 'owner-replay', requestDigest: 'a'.repeat(64), notBefore: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      cases: [{ id: 'tool', kind: 'tool', name: 'endpoint_probe', arguments: {} }, { id: 'reply', kind: 'delivery', text: 'blocked reply' }] },
    agent: { cwd: root, preset: 'primary', provider: 'fixture', model: 'fixture' },
  }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })

  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow' })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false })
  let bodies = 0, creates = 0
  const registerProbe = (agentCtx: Context) => agentCtx.tools.register(defineTool({ name: 'endpoint_probe', description: 'Probe.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: async () => { bodies += 1; return {} },
  }))
  ctx.on('agent/session-start', ({ agent }) => {
    registerProbe(agent.ctx)
    creates += 1
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
  })
  ctx.baseUrl = pathToFileURL(join(profile, 'cordis.yml')).href
  await ctx.plugin(Loader)
  const entry = { id: 'candidate', name: './candidate.js', config: {} }
  await ctx.loader.create(entry); await ctx.loader.await()
  const mount = async (endpointConfig: ReplayEndpointConfig = config) => {
    const fiber = ctx.plugin({ name: 'endpoint-owner', apply(ownerCtx) { installReplayEndpoint(ownerCtx, endpointConfig) } })
    await fiber
    await expect.poll(async () => {
      try {
        // bind creates the pathname before the endpoint finishes chmod.
        // Readiness must meet the same owner/mode contract as the client.
        const stat = await lstat(config.runtime.socketPath)
        return stat.isSocket() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0
      } catch { return false }
    }).toBe(true)
    return fiber
  }
  const query = (action: 'execute' | 'query', overrides = {}) => queryReplayEndpoint({ socketPath: config.runtime.socketPath,
    keyPath, action, operationId: config.authority.operationId, requestDigest: config.authority.requestDigest, timeoutMs: 6000, ...overrides })
  return { root, ctx, config, mount, query, creates: () => creates, bodies: () => bodies }
}

test('authenticates actual native replay, returns stable cached result, and discards the native Agent', async () => {
  const f = await fixture(); await f.mount()
  expect((await f.query('query')).status).toBe('not-started')
  const reply = await f.query('execute')
  expect(reply.status).toBe('completed')
  expect(reply.result?.attempts.map(item => item.blockedAt)).toEqual(['native-tool-guard', 'delivery-reply-admission'])
  expect((await f.query('execute')).result).toEqual(reply.result)
  expect(f.ctx.agents.get(reply.result!.sessionId as never)).toBeUndefined()
  expect(f.creates()).toBe(1); expect(f.bodies()).toBe(0)
})

test('wrong key and request binding refuse before native creation', async () => {
  const f = await fixture(); await f.mount()
  const wrong = join(f.root, 'owner', 'wrong.key'); await writeFile(wrong, randomBytes(32), { mode: 0o600 })
  await expect(f.query('execute', { keyPath: wrong })).rejects.toThrow()
  await expect(f.query('execute', { requestDigest: 'b'.repeat(64) })).rejects.toThrow()
  expect(f.creates()).toBe(0)
})

test('concurrent execute requests have one dispatch; persisted completion becomes stale after endpoint replacement', async () => {
  const f = await fixture(); const fiber = await f.mount()
  const results = await Promise.all([f.query('execute'), f.query('execute')])
  expect(results.some(result => result.status === 'completed')).toBe(true)
  expect(f.creates()).toBe(1)
  await fiber.dispose(); await expect(lstat(f.config.runtime.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.mount()
  expect((await f.query('execute')).status).toBe('stale')
  expect(f.creates()).toBe(1)
})

test('reserved operation after interruption remains unknown across journal and endpoint reopen', async () => {
  const f = await fixture()
  const journal = new ReplayJournal(f.config.journalPath)
  expect(journal.reserve(f.config.authority.operationId, runtimeConfigDigest(f.config), f.config.authority.requestDigest, runtimeConfigDigest(f.config.authority.cases))).toBe(true)
  journal.close()
  await f.mount()
  expect((await f.query('execute')).status).toBe('unknown')
  expect(f.creates()).toBe(0)
})

test('native pre-execution refusal remains unknown and is never rerun', async () => {
  const f = await fixture()
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'fixture earlier guard' }))
  await f.mount()
  expect((await f.query('execute')).status).toBe('unknown')
  expect((await f.query('execute')).status).toBe('unknown')
  expect(f.creates()).toBe(1); expect(f.bodies()).toBe(0)
})

test('cached success refuses Loader generation drift', async () => {
  const f = await fixture(); await f.mount()
  expect((await f.query('execute')).status).toBe('completed')
  await f.ctx.loader.update('candidate', { disabled: true }); await f.ctx.loader.await()
  expect((await f.query('query')).status).toBe('stale')
  expect(f.creates()).toBe(1)
})

test('expired owner authority cannot dispatch', async () => {
  const f = await fixture()
  f.config.authority.notBefore = Date.now() - 2000; f.config.authority.expiresAt = Date.now() - 1000
  await f.mount()
  await expect(f.query('execute')).rejects.toThrow()
  expect(f.creates()).toBe(0)
})

test('unloading an endpoint aborts and drains its native replay before removing the socket', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.ctx.on('tools/pre-execute', async (_execution, next) => { entered(); await gate; return next() })
  const fiber = await f.mount()
  const request = f.query('execute').catch(() => undefined)
  await started
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
  } finally { release() }
  await disposal; await request
  await expect(lstat(f.config.runtime.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.mount()
  expect((await f.query('execute')).status).toBe('unknown')
  expect(f.creates()).toBe(1); expect(f.bodies()).toBe(0)
})

test('client timeout cannot redispatch a reserved operation', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.ctx.on('tools/pre-execute', async (_execution, next) => { entered(); await gate; return next() })
  await f.mount()
  const request = f.query('execute', { timeoutMs: 100 }).catch(() => undefined)
  await started
  try {
    await request
    expect((await f.query('execute')).status).toBe('unknown')
    expect(f.creates()).toBe(1)
  } finally { release() }
})

test('rejects client-supplied cases, malformed observations and invalid config before dispatch', async () => {
  const f = await fixture()
  expect(() => assertReplayEndpointRequest({ schemaVersion: 1, action: 'execute', operationId: 'owner-replay',
    requestDigest: 'a'.repeat(64), challenge: 'b'.repeat(64), cases: [] })).toThrow()
  expect(() => validateReplayEndpointConfig({ ...f.config, timeoutMs: 60_001 })).toThrow()
  expect(() => validateReplayEndpointConfig({ ...f.config, authority: { ...f.config.authority, cases: [null, null] } })).toThrow()
  await f.mount()
  const response = await f.query('execute')
  expect(response.status).toBe('completed')
  expect(() => assertReplayEndpointResponse({ ...response, result: { ...response.result, runtimeDigest: '0'.repeat(64) } })).toThrow()
  expect(() => assertReplayEndpointResponse({ ...response, result: { ...response.result,
    attempts: [response.result!.attempts[0], response.result!.attempts[0]] } })).toThrow()
})

test('Control Plane refuses shared key material between mutation and read-only channels', async () => {
  const f = await fixture()
  const observerKey = join(f.root, 'owner', 'observer.key')
  await writeFile(observerKey, await readFile(f.config.runtime.keyPath), { mode: 0o600 })
  expect(() => new PluginControlPlaneService(f.ctx, {
    statePath: join(f.root, 'state'), catalogPath: join(f.root, 'catalog.json'), trustPath: join(f.root, 'trust.json'),
    runtimeObserver: { ...f.config.runtime, socketPath: join(f.root, 'owner', 'observer.sock'), keyPath: observerKey },
    replayEndpoint: f.config,
  })).toThrow('distinct key material')
  expect(f.creates()).toBe(0)
})

async function signedFixture() {
  const f = await fixture()
  const keys = generateKeyPairSync('ed25519')
  const now = Date.now()
  const scope: ReplaySignedAuthority['scope'] = {
    installationId: '11111111-1111-4111-8111-111111111111',
    ledger: { id: '22222222-2222-4222-8222-222222222222', path: join(f.root, 'owner', 'control.sqlite') },
    plan: { id: 'plan', digest: 'b'.repeat(64) }, activation: { id: 'activation', fence: 1 },
    profile: { name: 'profile', path: f.config.runtime.profilePath },
  }
  const config: ReplayEndpointConfig = { ...f.config, authority: { mode: 'signed', authority: 'owner', keyId: 'key',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), scope,
    notBefore: now - 5000, expiresAt: now + 60000, maximumGrantMs: 30000, cases: f.config.authority.cases } }
  const request: HostAttestationRequest = { schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: 'late-op',
    requestedAt: now - 1000, receiptTtlMs: 60000, ...scope, issuer: { mode: 'owner-manual' }, phase: 'effect-blocked-replay',
    requirements: { kind: 'effect-blocked-replay', minimumDeliveryAttempts: 1, minimumToolExecutionAttempts: 1, maximumExternalEffects: 0 },
    predecessor: { operationId: 'ready-op', receiptId: 'ready-receipt', phase: 'readiness', receiptDigest: 'c'.repeat(64), hostGeneration: 1 } }
  const unsigned: Omit<ReplayGrant, 'signature'> = { schemaVersion: 1, kind: 'dsh-effect-replay-grant', authority: 'owner', keyId: 'key',
    request, endpointDigest: runtimeConfigDigest(config), caseDigest: runtimeConfigDigest(config.authority.cases),
    processId: process.pid, invocationId: /^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? '') ? process.env.INVOCATION_ID! : null,
    notBefore: now - 500, expiresAt: now + 29500 }
  const grant = (overrides: Partial<Omit<ReplayGrant, 'signature'>> = {}, privateKey = keys.privateKey): ReplayGrant => {
    const body = { ...structuredClone(unsigned), ...overrides }
    return { ...body, signature: sign(null, Buffer.from(replayGrantSigningPayload(body)), privateKey).toString('base64') }
  }
  const query = (action: 'execute' | 'query', signed: ReplayGrant | undefined = grant()) => f.query(action, {
    operationId: signed?.request.operationId ?? request.operationId,
    requestDigest: hostAttestationRequestDigest(signed?.request ?? request), ...(signed ? { grant: signed } : {}),
  })
  return { ...f, signedConfig: config, request, grant, signedQuery: query, mountSigned: () => f.mount(config) }
}

test('late signed authority executes on the already mounted endpoint once, without changing its config', async () => {
  const f = await signedFixture(); const configDigest = runtimeConfigDigest(f.signedConfig)
  await f.mountSigned()
  await expect(f.query('execute', { operationId: f.request.operationId, requestDigest: hostAttestationRequestDigest(f.request) })).rejects.toThrow()
  expect(f.creates()).toBe(0)
  const grant = f.grant()
  expect((await f.signedQuery('query', grant)).status).toBe('not-started')
  const results = await Promise.all([f.signedQuery('execute', grant), f.signedQuery('execute', grant)])
  const completed = results.find(result => result.status === 'completed')!
  expect(completed.result?.requestDigest).toBe(hostAttestationRequestDigest(f.request))
  expect(completed.result?.attempts.map(attempt => attempt.blockedAt)).toEqual(['native-tool-guard', 'delivery-reply-admission'])
  expect((await f.signedQuery('query', grant)).result).toEqual(completed.result)
  expect(runtimeConfigDigest(f.signedConfig)).toBe(configDigest)
  expect(f.creates()).toBe(1); expect(f.bodies()).toBe(0)
})

test('signed endpoint rejects forgery, wrong Host, request, scope, config, cases and expiry before Agent creation', async () => {
  const f = await signedFixture(); await f.mountSigned()
  const badGrants = [
    f.grant({}, generateKeyPairSync('ed25519').privateKey),
    f.grant({ processId: process.pid + 1 }), f.grant({ invocationId: 'f'.repeat(32) }),
    f.grant({ endpointDigest: 'e'.repeat(64) }), f.grant({ caseDigest: 'e'.repeat(64) }),
    f.grant({ request: { ...f.request, activation: { ...f.request.activation, fence: 2 } } }),
    f.grant({ expiresAt: Date.now() - 1 }),
  ]
  for (const grant of badGrants) await expect(f.signedQuery('execute', grant)).rejects.toThrow()
  const altered = f.grant(); altered.request.predecessor!.receiptDigest = 'd'.repeat(64)
  await expect(f.signedQuery('execute', altered)).rejects.toThrow()
  const good = f.grant()
  await expect(f.query('execute', { operationId: good.request.operationId, requestDigest: 'e'.repeat(64), grant: good })).rejects.toThrow()
  expect(f.creates()).toBe(0); expect(f.bodies()).toBe(0)
})

test('signed unknown survives endpoint replacement and refuses a freshly signed alternate operation or grant', async () => {
  const f = await signedFixture()
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'fixture earlier guard' }))
  const fiber = await f.mountSigned(); const grant = f.grant()
  expect((await f.signedQuery('execute', grant)).status).toBe('unknown')
  await fiber.dispose(); await f.mountSigned()
  expect((await f.signedQuery('execute', grant)).status).toBe('unknown')
  expect((await f.signedQuery('query', grant)).status).toBe('unknown')
  for (const changed of [f.grant({ expiresAt: grant.expiresAt - 1 }), f.grant({ request: { ...f.request, operationId: 'new-operation' } })]) {
    await expect(f.signedQuery('execute', changed)).rejects.toThrow()
    await expect(f.signedQuery('query', changed)).rejects.toThrow()
  }
  expect(f.creates()).toBe(1); expect(f.bodies()).toBe(0)
})

test('signed completed observations become stale on endpoint reload and are never redispatched', async () => {
  const f = await signedFixture(); const fiber = await f.mountSigned(); const grant = f.grant()
  expect((await f.signedQuery('execute', grant)).status).toBe('completed')
  await fiber.dispose(); await f.mountSigned()
  expect((await f.signedQuery('query', grant)).status).toBe('stale')
  expect((await f.signedQuery('execute', grant)).status).toBe('stale')
  expect(f.creates()).toBe(1)
})

test('a grant expiring during durable admission never creates an Agent or runs startup hooks', async () => {
  const f = await signedFixture(); await f.mountSigned(); const grant = f.grant()
  const reserve = ReplayJournal.prototype.reserve
  let clock: ReturnType<typeof vi.spyOn> | undefined
  const admission = vi.spyOn(ReplayJournal.prototype, 'reserve').mockImplementation(function (this: ReplayJournal, ...args) {
    const result = reserve.apply(this, args)
    // SQLite lock acquisition/fsync can consume the entire short grant window.
    clock = vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
    return result
  })
  try {
    expect((await f.signedQuery('execute', grant)).status).toBe('unknown')
    expect(f.creates()).toBe(0); expect(f.bodies()).toBe(0)
  } finally { admission.mockRestore(); clock?.mockRestore() }
  expect((await f.signedQuery('query', grant)).status).toBe('unknown')
  expect((await f.signedQuery('execute', grant)).status).toBe('unknown')
  expect(f.creates()).toBe(0)
})
