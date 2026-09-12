import { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { OwnerRepairAgentRuntime, type OwnerRepairAgentInput } from '../src/repair-agent.js'

const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'repair' }
const input = (): OwnerRepairAgentInput => ({ id: 'authorization-1', authorizationDigest: 'digest', scope, ownerRouteId: 'route',
  trigger: { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective: 'Repair' },
    failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1,
    evidence: { producer: 'assistant-goals', generation: 'generation', digest: 'digest' } }, objective: 'Repair', maxGoalRounds: 1, expiresAt: Date.now() + 60_000,
  provider: 'provider', model: 'model', maxModelCalls: 1, maxToolCalls: 0, maxOutputTokens: 10, maxDurationMs: 1_000, allowedTools: [], assertCurrent: () => {} })

test('rejects malformed or expired repair bootstrap before creating an Agent', async () => {
  const runtime = new OwnerRepairAgentRuntime(new Context())
  const expired = { ...input(), expiresAt: Date.now() - 1 }
  await expect(runtime.create(expired)).rejects.toThrow(/invalid owner repair Agent input/u)
  const malformed = { ...input(), allowedTools: ['read', 'read'] }
  await expect(runtime.create(malformed)).rejects.toThrow(/invalid owner repair Agent input/u)
  await runtime.dispose()
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
