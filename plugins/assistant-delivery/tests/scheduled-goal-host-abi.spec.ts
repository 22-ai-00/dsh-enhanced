import { describe, expect, test } from 'vitest'
import { DshDeliveryRuntime } from '../src/agent-runtime.ts'

type Handler = (payload: any, next: () => Promise<any>) => Promise<any>

const goalSource = (overrides: Record<string, unknown> = {}) => ({
  kind: 'goal', goalId: 'native-goal', revision: 2, round: 1, ...overrides,
})
const runtimeSource = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }

function fixture() {
  const handlers = new Map<string, Handler>()
  const signal = new AbortController()
  let cancelled = 0
  let events: any[] = [{ seq: 1, type: 'turn/start', data: { turn: 7 } }]
  const native = { id: 'native-goal', revision: 2, phase: 'active', roundsStarted: 0, maxGoalRounds: 3 }
  const agent: any = {
    session: { id: 'session', snapshotEvents: () => events },
    cancel: () => { cancelled += 1 },
    ctx: {
      on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
      tools: { guard: () => () => {} },
    },
  }
  const ctx: any = { get: (name: string) => name === 'goals' ? { get: () => native } : undefined }
  const runtime = new DshDeliveryRuntime(ctx, {} as any, { sessionLeases: { assert: () => {} } } as any)
  const input: any = {
    native: { goalId: 'native-goal', revision: 1 }, signal: signal.signal, deadlineAt: Date.now() + 60_000,
    assertCurrent: () => {},
  }
  const release = (runtime as any).installScheduledGoalFences(agent, input) as () => void
  const pre = handlers.get('agent/pre-step')!
  const request = handlers.get('agent/request')!
  let messageId = 0
  const message = (source: Record<string, unknown>) => ({ id: `message-${++messageId}`, role: 'user', content: [], source })
  const enter = async (messages: any[]) => ({ kind: 'enter' as const, messages })
  return {
    agent, cancelled: () => cancelled, enter, events: (value?: any[]) => value === undefined ? events : (events = value),
    input, message, native, pre, release, request, signal,
  }
}

describe('scheduled goal fences across Host pre-step ABI orderings', () => {
  test('accepts the new pre-step → request order only for the selected exact goal step', async () => {
    const f = fixture()
    const goal = f.message(goalSource())
    await expect(f.pre({ agent: f.agent, messages: [goal, f.message(runtimeSource)], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([goal, f.message(runtimeSource)])))
      .resolves.toMatchObject({ kind: 'enter' })
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => ({ provider: 'test' })))
      .resolves.toEqual({ provider: 'test' })
    expect(f.cancelled()).toBe(0)
    // The proof is consumed by this request: a retry cannot turn it into a
    // reusable authority after the loop failed to append the input.
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => ({ provider: 'test' })))
      .rejects.toThrow('scheduled goal wake authorization changed')
    f.release()
  })

  test('keeps the old durable-append-before-request ordering', async () => {
    const f = fixture()
    f.events([{ seq: 1, type: 'turn/start', data: { turn: 7 } }, { seq: 2, type: 'user/message', data: { source: goalSource() } }])
    f.native.roundsStarted = 1
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => ({ provider: 'test' })))
      .resolves.toEqual({ provider: 'test' })
    f.release()
  })

  test.each([
    ['reject', (f: ReturnType<typeof fixture>, goal: any) => f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, async () => ({ kind: 'reject' }))],
    ['replacement', (f: ReturnType<typeof fixture>, goal: any) => f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([f.message(goalSource({ goalId: 'other' }))]))],
    ['same-source replacement', (f: ReturnType<typeof fixture>, goal: any) => f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([f.message(goalSource())]))],
    ['in-place content replacement', (f: ReturnType<typeof fixture>, goal: any) => f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => { goal.content.push({ type: 'text', text: 'replacement' }); return f.enter([goal]) })],
    ['multiple inputs', (f: ReturnType<typeof fixture>, goal: any) => f.pre({ agent: f.agent, messages: [goal, f.message(goalSource())], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([goal, f.message(goalSource())]))],
  ])('does not bridge a %s pre-step decision', async (_name, establish) => {
    const f = fixture(); const goal = f.message(goalSource())
    await establish(f, goal)
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => ({ provider: 'test' })))
      .rejects.toThrow('scheduled goal wake authorization changed')
    f.release()
  })

  test.each([
    ['wrong turn', (f: ReturnType<typeof fixture>) => ({ turn: 8, step: 3, signal: f.signal.signal })],
    ['wrong step', (f: ReturnType<typeof fixture>) => ({ turn: 7, step: 4, signal: f.signal.signal })],
    ['native revision change', (f: ReturnType<typeof fixture>) => { f.native.revision = 3; return { turn: 7, step: 3, signal: f.signal.signal } }],
    ['native round advance without durable input', (f: ReturnType<typeof fixture>) => { f.native.roundsStarted = 1; return { turn: 7, step: 3, signal: f.signal.signal } }],
    ['turn ended', (f: ReturnType<typeof fixture>) => { f.events().push({ seq: 2, type: 'turn/end', data: { turn: 7 } }); return { turn: 7, step: 3, signal: f.signal.signal } }],
    ['abort', (f: ReturnType<typeof fixture>) => { f.signal.abort(); return { turn: 7, step: 3, signal: f.signal.signal } }],
  ])('rejects an established bridge after %s', async (_name, change) => {
    const f = fixture(); const goal = f.message(goalSource())
    await f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([goal]))
    const payload = change(f)
    await expect(f.request({ agent: f.agent, ...payload }, async () => ({ provider: 'test' })))
      .rejects.toThrow('scheduled goal wake authorization changed')
    f.release()
  })

  test('consumes the bridge even when request entry is rejected', async () => {
    const f = fixture(); const goal = f.message(goalSource())
    await f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([goal]))
    await expect(f.request({ agent: f.agent, turn: 7, step: 4, signal: f.signal.signal }, async () => ({}))).rejects.toThrow()
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => ({}))).rejects.toThrow()
    f.release()
  })

  test('rechecks newly durable input after downstream request preparation', async () => {
    const f = fixture(); const goal = f.message(goalSource())
    await f.pre({ agent: f.agent, messages: [goal], turn: 7, step: 3, signal: f.signal.signal }, () => f.enter([goal]))
    await expect(f.request({ agent: f.agent, turn: 7, step: 3, signal: f.signal.signal }, async () => {
      f.events().push({ seq: 2, type: 'user/message', data: { source: goalSource({ goalId: 'foreign' }) } })
      f.native.roundsStarted = 1
      return {}
    })).rejects.toThrow('scheduled goal wake authorization changed')
    f.release()
  })
})
