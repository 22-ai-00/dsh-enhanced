import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test as nativeTest } from 'vitest'
import { EffectBlockedReplayRuntime } from '../src/effect-blocked-replay.js'
import { runtimeConfigDigest, type RuntimeObserverConfig } from '../src/runtime-observer.js'

// The authenticated runtime observer contract is Linux-only, like its suite.
const test = nativeTest.skipIf(process.platform !== 'linux')

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  for (const { ctx, root } of fixtures.splice(0).reverse()) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'effect-blocked-replay-'))
  const ctx = new Context(); fixtures.push({ ctx, root })
  const owner = join(root, 'owner'), profile = join(root, 'profile')
  await mkdir(owner, { recursive: true, mode: 0o700 }); await chmod(owner, 0o700)
  await mkdir(profile, { recursive: true })
  const keyPath = join(owner, 'observer.key')
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const module = './node_modules/replay-candidate/index.js'
  const candidate = join(profile, 'node_modules', 'replay-candidate')
  await mkdir(candidate, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'replay-candidate', type: 'module', exports: './index.js' }))
  await writeFile(join(candidate, 'index.js'), "export default { name: 'replay-candidate', apply(ctx) { ctx.provide('replayCandidateService', { active: true }) } }\n")
  const config: RuntimeObserverConfig = {
    socketPath: join(owner, 'observer.sock'), keyPath, profilePath: profile,
    targets: [{ entryId: 'replay-candidate', module, configDigest: runtimeConfigDigest({}), services: ['replayCandidateService'] }],
  }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })

  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow' })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false })
  let toolBodies = 0
  const registerProbe = (agentCtx: Context) => { agentCtx.tools.register(defineTool({ name: 'replay_effect_probe', description: 'Native effect probe.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { executed: { type: 'boolean', required: true } } }, render: () => [] },
    execute: async () => { toolBodies += 1; return { executed: true } },
  })) }
  const target = await ctx.agents.create({ sessionId: SessionId('replay-target'), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup: registerProbe })
  const other = await ctx.agents.create({ sessionId: SessionId('replay-other'), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup: registerProbe })
  for (const handle of [target, other]) {
    handle.agent.session.append('approval/policy', { policy: 'never' })
    handle.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = handle.agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(handle.agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
  }
  ctx.baseUrl = pathToFileURL(join(profile, 'cordis.yml')).href
  await ctx.plugin(Loader)
  const entry = { id: 'replay-candidate', name: module, config: {} }
  await ctx.loader.create(entry)
  await ctx.loader.await()
  const runtime = new EffectBlockedReplayRuntime(ctx, config)
  const outbox = () => (ctx.assistantDelivery as unknown as { deliveryStore: { listOutbox(input: unknown): unknown[] } }).deliveryStore.listOutbox({})
  return { ctx, config, runtime, target, other, outbox, toolBodies: () => toolBodies }
}

test('rejects Agent scopes and inherited Agent scopes as replay runtime owners', async () => {
  const f = await fixture()
  expect(() => new EffectBlockedReplayRuntime(f.target.agent.ctx, f.config)).toThrow('unscoped Host Fiber')
  expect(() => new EffectBlockedReplayRuntime(f.target.agent.ctx.extend(), f.config)).toThrow('unscoped Host Fiber')
})

function replayInput(handle: { agent: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['ctx']['agents']['create']>>['agent']; dispose(): Promise<void> }, operationId: string, signal = new AbortController().signal, cases = [
  { id: 'tool-1', kind: 'tool' as const, name: 'replay_effect_probe', arguments: {} },
  { id: 'delivery-1', kind: 'delivery' as const, text: 'this reply must not create an outbox record' },
]) {
  return { handle, operationId, requestDigest: 'a'.repeat(64), cases, expiresAt: Date.now() + 30_000, signal }
}

test('uses actual native ToolRuntime and Delivery admission: target effects are blocked, recorded, and reclaimed without affecting another Agent', async () => {
  const f = await fixture()
  const result = await f.runtime.run(replayInput(f.target, 'effect-replay-native-1'))
  expect(result).toMatchObject({ schemaVersion: 1, kind: 'dsh-effect-blocked-replay-observation', operationId: 'effect-replay-native-1',
    quiescent: true, attempts: [
      { caseId: 'tool-1', kind: 'tool', blockedAt: 'native-tool-guard' },
      { caseId: 'delivery-1', kind: 'delivery', blockedAt: 'delivery-reply-admission' },
    ] })
  expect(result.attempts.map(item => item.callId)).toEqual(['effect-replay-native-1:tool-1', 'effect-replay-native-1:delivery-1'])
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  const allowed = await f.other.agent.ctx.tools.execute({ callId: 'other-agent-call' as never, name: 'replay_effect_probe', arguments: {},
    agent: f.other.agent, signal: new AbortController().signal })
  expect(allowed).toMatchObject({ isError: false })
  expect(f.toolBodies()).toBe(1)
  await f.other.dispose()
})

test('rejects a native pre-execute denial instead of treating it as this runtime’s guard proof', async () => {
  const f = await fixture()
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'fixture pre-hook denied before monotonic guard' }))
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-prehook-1'))).rejects.toThrow('native monotonic denial was not observed')
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('rejects a post-execute result rewrite instead of accepting it as the native guard denial', async () => {
  const f = await fixture()
  let postCalls = 0
  f.ctx.on('tools/post-execute', async (_execution, _result) => {
    postCalls += 1
    return { kind: 'accept', value: { rewritten: true } }
  })
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-posthook-1'))).rejects.toThrow('native monotonic denial was not observed')
  expect(postCalls).toBeGreaterThan(0)
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('rejects an additional native ToolRuntime call for the owned Agent', async () => {
  const f = await fixture()
  let injected = false
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent && !injected) {
      injected = true
      await f.target.agent.ctx.tools.execute({ callId: 'unexpected-native-call' as never, name: 'replay_effect_probe', arguments: {},
        agent: f.target.agent, signal: new AbortController().signal })
    }
    return await next()
  })
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-extra-native-1'))).rejects.toThrow()
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('rejects an additional Delivery reply callback for the owned Agent', async () => {
  const f = await fixture()
  let injected = false
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent && !injected) {
      injected = true
      expect(() => f.ctx.assistantDelivery.reply(f.target.agent, { idempotencyKey: 'unexpected-delivery-reply', text: 'must stay blocked', format: 'plain' })).toThrow()
    }
    return await next()
  })
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-extra-delivery-1'))).rejects.toThrow()
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('rejects a foreign native Host and ToolRuntime realm before consuming its handle', async () => {
  const local = await fixture(), foreign = await fixture()
  expect(() => local.runtime.run(replayInput(foreign.target, 'effect-replay-foreign-1'))).toThrow('Agent is not registered in this Host')
  expect(foreign.ctx.agents.get(foreign.target.agent.id)).toBe(foreign.target.agent)
  expect(foreign.toolBodies()).toBe(0)
  expect(foreign.outbox()).toEqual([])
})

test('rejects an apparent disposer success when the native Agent remains registered', async () => {
  const f = await fixture()
  const nonReclaiming = { agent: f.target.agent, dispose: async () => {} }
  await expect(f.runtime.run(replayInput(nonReclaiming, 'effect-replay-fake-dispose-1'))).rejects.toThrow('native Agent was not reclaimed')
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBe(f.target.agent)
  await f.target.dispose(); await f.other.dispose()
})

test('cancels an admitted native execution and never reports success', async () => {
  const f = await fixture(), abort = new AbortController()
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent) abort.abort()
    return await next()
  })
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-abort-1', abort.signal))).rejects.toThrow()
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('owner Fiber disposal aborts a pending replay, drains it after its native hook settles, and reclaims the Agent', async () => {
  const f = await fixture()
  let nested!: EffectBlockedReplayRuntime
  const owner = await f.ctx.plugin({ name: 'nested-replay-owner', inject: ['tools', 'loader', 'assistantDelivery', 'agents'],
    apply(ctx: Context) { nested = new EffectBlockedReplayRuntime(ctx, (f.runtime as unknown as { config: RuntimeObserverConfig }).config) } })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent) { entered(); await gate }
    return await next()
  })
  const pending = nested.run(replayInput(f.target, 'effect-replay-owner-dispose-1'))
  await started
  const disposing = owner.dispose()
  release()
  await expect(pending).rejects.toThrow()
  await disposing
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('rejects a candidate reload that occurs after admission and before the native guard can prove a stable replay', async () => {
  const f = await fixture()
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent) await f.ctx.loader.update('replay-candidate', { config: { replaced: true } })
    return await next()
  })
  await expect(f.runtime.run(replayInput(f.target, 'effect-replay-reload-1'))).rejects.toThrow()
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  expect(f.ctx.agents.get(f.target.agent.id)).toBeUndefined()
  await f.other.dispose()
})

test('freezes cases and rejects a duplicate operation while the first native replay is pending', async () => {
  const f = await fixture()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  f.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === f.target.agent) await blocked
    return await next()
  })
  const cases = [
    { id: 'tool-1', kind: 'tool' as const, name: 'replay_effect_probe', arguments: {} },
    { id: 'delivery-1', kind: 'delivery' as const, text: 'frozen delivery text' },
  ]
  const first = f.runtime.run(replayInput(f.target, 'effect-replay-freeze-1', new AbortController().signal, cases))
  expect(() => f.runtime.run(replayInput(f.target, 'effect-replay-freeze-1'))).toThrow('duplicate')
  cases[0]!.name = 'changed_after_admission'
  cases[1]!.text = 'changed_after_admission'
  release()
  await expect(first).resolves.toMatchObject({ attempts: [{ caseId: 'tool-1' }, { caseId: 'delivery-1' }] })
  expect(f.toolBodies()).toBe(0)
  expect(f.outbox()).toEqual([])
  await f.other.dispose()
})
