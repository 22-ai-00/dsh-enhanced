import { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { OwnerRepairAgentRuntime, type OwnerRepairAgentInput } from '../src/repair-agent.js'
import { SkillStore } from '../src/store.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'repair' }
const input = (): OwnerRepairAgentInput => ({ id: 'authorization-1', authorizationDigest: 'digest', scope, ownerRouteId: 'route',
  trigger: { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective: 'Repair' },
    failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1,
    evidence: { producer: 'assistant-goals', generation: 'generation', digest: 'digest' } }, objective: 'Repair', maxGoalRounds: 1, expiresAt: Date.now() + 60_000,
  provider: 'provider', model: 'model', maxModelCalls: 1, maxToolCalls: 0, maxOutputTokens: 10, maxDurationMs: 1_000, allowedTools: [], assertCurrent: () => {} })

test('released repair handles reattach through resume while preserving the original deadline and native identity', async () => {
  const store = new SkillStore(':memory:')
  const record = store.createRepairContinuation(scope, { invocationId: 'resume', ownerRouteId: 'route', source: { goalId: 'source', sessionId: 'source-session', nativeGoalId: 'source-native', definitionDigest: 'a'.repeat(64) },
    profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'repair-skill', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 1, expiresAt: Date.now() + 60_000 }, {})
  const original = { ...input(), id: record.id, authorizationDigest: record.authorizationDigest, expiresAt: record.authorization.expiresAt, maxDurationMs: 30_000 }
  const create = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ agent: { session: { id: sessionId } }, dispose: async () => {} }))
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => ({ agent: { session: { id: resumeSessionId } }, dispose: async () => {} }))
  const startGoal = vi.fn(async () => ({ id: 'original-goal' })), resumeGoal = vi.fn(async (_agent: unknown) => ({ id: 'original-goal' }))
  const ctx = { effect() {}, get: (name: string) => ({ agents: { create, resume }, assistantGoals: { startOwnerAuthorizedRepair: startGoal, resumeOwnerAuthorizedRepair: resumeGoal },
    assistantPolicy: { bindInitiator: () => () => {} }, sessions: { flush: async () => {} } })[name as 'agents'] } as unknown as Context
  const first = new OwnerRepairAgentRuntime(ctx, store), second = new OwnerRepairAgentRuntime(ctx, store)
  try {
    const made = await first.create(original), before = store.inspectRepairExecution(scope, record.id, 1)!
    await first.closeSession(made.sessionId)
    const reference = { ...made, nativeGoalId: 'original-native', definitionDigest: 'a'.repeat(64) }
    const restored = await second.resume({ ...original, maxDurationMs: 60_000 }, reference)
    expect(restored).toEqual(made)
    expect(store.inspectRepairExecution(scope, record.id, 1)).toMatchObject({ deadlineAt: before.deadlineAt, fence: before.fence + 1 })
    expect(create).toHaveBeenCalledTimes(1); expect(startGoal).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1); expect(resumeGoal.mock.calls[0]?.[0]).toBe(second.get(made.sessionId))
    await expect(second.resume(original, reference)).rejects.toThrow(/unavailable/u)
    expect(resume).toHaveBeenCalledTimes(1)
  } finally { await first.dispose(); await second.dispose(); store.close() }
})

test('rejects malformed or expired repair bootstrap before creating an Agent', async () => {
  const runtime = new OwnerRepairAgentRuntime(new Context())
  const expired = { ...input(), expiresAt: Date.now() - 1 }
  await expect(runtime.create(expired)).rejects.toThrow(/invalid owner repair Agent input/u)
  const malformed = { ...input(), allowedTools: ['read', 'read'] }
  await expect(runtime.create(malformed)).rejects.toThrow(/invalid owner repair Agent input/u)
  await runtime.dispose()
})

test('production repair runtime confines native file tools before their delegate, including symlink escapes', async () => {
  // Exercise the configured symlink and its canonical target, including on
  // macOS where tmpdir() itself can use the /var -> /private/var alias.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repair-workspace-')))
  const privateRoot = await mkdtemp(join(tmpdir(), 'repair-private-'))
  await writeFile(join(root, 'artifact.txt'), 'repairable')
  await writeFile(join(privateRoot, 'holdout.txt'), 'private')
  await symlink(privateRoot, join(root, 'private-link'))
  const configuredWorkspace = `${root}-workspace-link`
  await symlink(root, configuredWorkspace)
  let dispatch!: (execution: { agent: unknown, name: string, arguments: unknown, signal: AbortSignal, callId: string }, next: () => Promise<{ isError: boolean }>) => Promise<{ isError: boolean }>
  let delegated = 0
  let current = true
  const agent = { session: { id: 'repair-files' }, cancel: vi.fn() }
  const agentCtx = {
    effect: (acquire: () => unknown) => acquire(),
    tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'read_image' }], guard: () => {} },
    on: (name: string, listener: typeof dispatch) => { if (name === 'tools/execute') dispatch = listener; return () => {} },
  }
  const ctx = { effect: () => {}, get: (name: string) => {
    if (name === 'agents') return { create: async ({ setup, sessionId }: { setup: (ctx: typeof agentCtx, agent: unknown) => Promise<void>, sessionId: string }) => {
      agent.session.id = sessionId
      await setup(agentCtx, agent)
      return { agent, dispose: async () => {} }
    } }
    if (name === 'assistantGoals') return { startOwnerAuthorizedRepair: async () => ({ id: 'goal' }) }
    if (name === 'assistantPolicy') return { bindInitiator: () => () => {} }
    return undefined
  } } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx)
  const repairInput = { ...input(), scope: { ...scope, workspace: configuredWorkspace }, trigger: { ...input().trigger, scope: { ...scope, workspace: configuredWorkspace } }, allowedTools: ['read', 'write', 'edit', 'read_image'], maxToolCalls: 4,
    assertCurrent: () => { if (!current) throw new Error('owner authorization revoked') } }
  const call = async (name: 'read' | 'write' | 'edit' | 'read_image', file_path: string, arguments_: Record<string, unknown> = {}) => await dispatch({ agent, name, arguments: { file_path, ...arguments_ }, signal: new AbortController().signal, callId: `${name}-${file_path}` }, async () => { delegated++; return { isError: false } })
  try {
    await runtime.create(repairInput)
    await expect(call('read', 'artifact.txt')).resolves.toEqual({ isError: false })
    await expect(call('write', join(root, 'new/nested-artifact.txt'), { content: 'new' })).resolves.toEqual({ isError: false })
    await expect(call('edit', 'new-source.txt', { old_string: 'old', new_string: 'new' })).resolves.toEqual({ isError: false })
    await expect(call('read_image', join(root, 'artifact.txt'))).resolves.toEqual({ isError: false })
    expect(delegated).toBe(4)
    for (const [name, filePath, arguments_] of [
      ['read', join(privateRoot, 'holdout.txt'), {}],
      ['write', '../private.txt', { content: 'private' }],
      ['edit', 'private-link/holdout.txt', { old_string: 'private', new_string: 'changed' }],
    ] as const) await expect(call(name, filePath, arguments_)).rejects.toThrow(/outside its workspace/u)
    expect(delegated).toBe(4)
    await expect(dispatch({ agent, name: 'read', arguments: null, signal: new AbortController().signal, callId: 'malformed' }, async () => { delegated++; return { isError: false } })).rejects.toThrow(/invalid owner repair file tool arguments/u)
    expect(delegated).toBe(4)
    current = false
    await expect(call('read', 'artifact.txt')).rejects.toThrow(/authorization revoked/u)
    expect(delegated).toBe(4)
  } finally {
    await runtime.dispose()
    await rm(configuredWorkspace, { force: true }); await rm(root, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true })
  }
})

test.each([
  ['native', 'legacy'],
  ['repair', 'current'],
] as const)('a %s abort at normal provider return keeps its effect pending after %s Agent setup', async (source, abi) => {
  const store = new SkillStore(':memory:')
  const record = store.createRepairContinuation(scope, { invocationId: `abort-${source}`, ownerRouteId: 'route', source: { goalId: 'source', sessionId: 'source-session', nativeGoalId: 'source-native', definitionDigest: 'a'.repeat(64) },
    profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'repair-skill', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 1, expiresAt: Date.now() + 60_000 }, {})
  const original = { ...input(), id: record.id, authorizationDigest: record.authorizationDigest, expiresAt: record.authorization.expiresAt, maxDurationMs: 30_000 }
  const repairAbort = new AbortController(), nativeAbort = new AbortController()
  let stream!: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  const create = async ({ sessionId, setup }: { sessionId: string; setup: (ctx: unknown, agent?: unknown) => Promise<void> }) => {
    const agent = { session: { id: sessionId }, cancel: vi.fn() }
    const runtime = { effect: (acquire: () => unknown) => acquire(), tools: { schemas: () => [], guard: () => {} },
      on: (name: string, listener: typeof stream) => { if (name === 'llm/stream') stream = listener; return () => {} } }
    const agentCtx = abi === 'legacy'
      ? { ...runtime, agent }
      : new Proxy(runtime, { get(target, key, receiver) {
        if (key === 'agent') throw new Error('current Agent setup must use its prepared Agent')
        return Reflect.get(target, key, receiver)
      } })
    if (abi === 'legacy') await setup(agentCtx)
    else await setup(agentCtx, agent)
    return { agent, dispose: async () => {} }
  }
  const ctx = { effect() {}, get: (name: string) => ({ agents: { create }, assistantGoals: { startOwnerAuthorizedRepair: async () => ({ id: 'goal' }) },
    assistantPolicy: { bindInitiator: () => () => {} }, sessions: { flush: async () => {} } })[name as 'agents'] } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx, store)
  try {
    const made = await runtime.create(original, repairAbort.signal)
    const options: GenerateOptions = { sessionId: SessionId(made.sessionId), provider: 'provider', model: 'model', messages: [], maxTokens: 10, tools: [], signal: nativeAbort.signal }
    const consume = async () => {
      for await (const _chunk of stream(options, async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
        ;(source === 'native' ? nativeAbort : repairAbort).abort(new Error('cancelled after final chunk'))
      })) { /* consume the provider's terminal chunk before its normal return */ }
    }
    await expect(consume()).rejects.toThrow('cancelled after final chunk')
    await runtime.closeSession(made.sessionId)
    expect(store.inspectRepairExecution(scope, record.id, 1)).toMatchObject({ state: 'active', pendingModel: 1 })
  } finally { await runtime.dispose(); store.close() }
})

test('disposing while creation is in flight aborts and waits for its late result', async () => {
  let release!: () => void
  const entered = vi.fn()
  const gate = new Promise<void>(resolve => { release = resolve })
  const ctx = {
    effect: () => {},
    get: (name: string) => {
      if (name === 'agents') return { create: async ({ signal }: { signal: AbortSignal }) => { entered(); await gate; signal.throwIfAborted(); throw new Error('late create must not publish') } }
      if (name === 'assistantGoals') return { startOwnerAuthorizedRepair: () => { throw new Error('unreachable') } }
      if (name === 'assistantPolicy') return { bindInitiator: () => () => {} }
      return undefined
    },
  } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx)
  const creating = runtime.create(input())
  await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1))
  const stopping = runtime.dispose()
  release()
  await expect(creating).rejects.toThrow(/runtime disposed/u)
  await expect(stopping).resolves.toBeUndefined()
  expect(runtime.get('owner-repair-any')).toBeUndefined()
})


test('a Goals-start failure after Agent publication releases its handle, controller and deadline', async () => {
  vi.useFakeTimers()
  const disposed = vi.fn(async () => {})
  const ctx = { effect: () => {}, get: (name: string) => {
    if (name === 'agents') return { create: async () => ({ agent: {}, dispose: disposed }) }
    if (name === 'assistantGoals') return { startOwnerAuthorizedRepair: async () => { throw new Error('goal start failed') } }
    if (name === 'assistantPolicy') return { bindInitiator: () => () => {} }
    return undefined
  } } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx)
  try {
    await expect(runtime.create(input())).rejects.toThrow('goal start failed')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    const abort = vi.spyOn(AbortController.prototype, 'abort')
    await runtime.closeAuthorization('authorization-1')
    expect(abort).not.toHaveBeenCalled()
    abort.mockRestore()
    await runtime.dispose()
  } finally { vi.restoreAllMocks(); vi.useRealTimers() }
})

test('uses a distinct repair session per iteration while preserving the frozen authorization id', async () => {
  const sessions: string[] = []
  const ctx = { effect: () => {}, get: (name: string) => {
    if (name === 'agents') return { create: async ({ sessionId }: { sessionId: string }) => { sessions.push(sessionId); return { agent: {}, dispose: async () => {} } } }
    if (name === 'assistantGoals') return { startOwnerAuthorizedRepair: async () => ({ id: 'goal' }) }
    if (name === 'assistantPolicy') return { bindInitiator: () => () => {} }
    return undefined
  } } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx)
  await runtime.create({ ...input(), iteration: 1 }); await runtime.create({ ...input(), iteration: 2 })
  expect(sessions).toHaveLength(2); expect(sessions[0]).not.toBe(sessions[1])
  await expect(runtime.create({ ...input(), iteration: 1 })).rejects.toThrow(/not retry-safe/u)
  await runtime.dispose()
})
