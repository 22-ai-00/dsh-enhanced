import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test as nativeTest } from 'vitest'
import { installReplayEndpoint, queryReplayEndpoint, type ReplayEndpointConfig } from '../src/replay-endpoint.js'
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
  const root = await mkdtemp(join(tmpdir(), 'replay-endpoint-'))
  const ctx = new Context(); fixtures.push({ ctx, root })
  const owner = join(root, 'owner'), profile = join(root, 'profile')
  await mkdir(owner, { mode: 0o700 }); await chmod(owner, 0o700); await mkdir(profile)
  const keyPath = join(owner, 'replay.key')
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const candidate = join(profile, 'candidate.js')
  await writeFile(join(profile, 'package.json'), '{"type":"module"}')
  await writeFile(candidate, "export default { name: 'candidate', apply(ctx) { ctx.provide('replayCandidate', {}) } }\n")
  const config: ReplayEndpointConfig = {
    runtime: { socketPath: join(owner, 'replay.sock'), keyPath, profilePath: profile,
      targets: [{ entryId: 'candidate', module: './candidate.js', configDigest: runtimeConfigDigest({}), services: ['replayCandidate'] }] },
    journalPath: join(owner, 'replay.sqlite'), timeoutMs: 5000,
    authority: { operationId: 'owner-replay', requestDigest: 'a'.repeat(64), notBefore: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      cases: [{ id: 'tool', kind: 'tool', name: 'endpoint_probe', arguments: {} }, { id: 'reply', kind: 'delivery', text: 'blocked reply' }] },
    agent: { cwd: root, preset: 'primary', provider: 'fixture', model: 'fixture' },
  }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' }, tools: { mode: 'native' } })
  new SessionProjectionRegistry(ctx)
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
  const mount = async () => {
    const fiber = ctx.plugin({ name: 'endpoint-owner', apply(ownerCtx) { installReplayEndpoint(ownerCtx, config) } })
    await fiber
    await expect.poll(async () => { try { return (await lstat(config.runtime.socketPath)).isSocket() } catch { return false } }).toBe(true)
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
