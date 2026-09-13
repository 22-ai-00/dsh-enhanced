import { describe, expect, test } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalExecutionRuntime } from '../src/execution.ts'

type Handler = (payload: any, next: () => Promise<any>) => Promise<any>

function fixture() {
  const handlers = new Map<string, Handler>()
  let dispose: (() => Promise<void>) | undefined
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'primary' }
  const objective = 'Execute exactly one native goal round'
  const definition = { version: 1, digest: acceptanceDigest({ objective }), objective }
  const record: any = { id: 'business-goal', scope, originalObjective: objective, definition,
    native: { sessionId: 'session', goalId: 'native-goal', revision: 1, objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 2, updatedAt: 1 },
    checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: 1, updatedAt: 1 }
  const native: any = { id: 'native-goal', revision: 1, phase: 'active', roundsStarted: 0, maxGoalRounds: 2 }
  let events: any[] = [{ seq: 1, type: 'turn/start', data: { turn: 2 } }]
  let cancellations = 0
  const agent: any = { session: { id: 'session', snapshotEvents: () => events }, cancel: () => { cancellations += 1 } }
  const verifier: any = { ownsTaskAcceptanceRegistration: () => true, tick: async () => undefined }
  const ctx: any = {
    logger: { warn: () => {} },
    get: (name: string) => ({ goals: { get: () => native }, sessions: { flush: async () => true }, assistantVerifier: verifier })[name],
    on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    inject: (_names: unknown, callback: (value: any) => unknown) => callback({ tools: { guard: () => () => {} } }),
    effect: (callback: () => () => Promise<void>) => { dispose = callback() },
  }
  const runtime = new GoalExecutionRuntime(ctx, ':memory:', 60_000, () => ({ scope, record }))
  runtime.register({ protocol: 'assistant-verifier/host-producer/v1', generation: runtime.generation(), owner: verifier, requiresAcceptance: true,
    prepare: () => ({ contractId: 'contract', contractDigest: 'a'.repeat(64) }), completed: async () => {} })
  const source = { kind: 'goal' as const, goalId: 'native-goal', revision: 1, round: 1 }
  const message = (value = source) => ({ role: 'user', content: [], source: value })
  return { agent, cancellations: () => cancellations, dispose: async () => await dispose?.(), record, events: (value: any[]) => { events = value }, handlers, message, native, runtime, source }
}

describe('native goal execution Host ABI admission', () => {
  test('admits the modern pre-step → request order only for the exact selected source', async () => {
    const f = fixture()
    try {
      const pre = f.handlers.get('agent/pre-step')!, request = f.handlers.get('agent/request')!
      const input = f.message()
      await pre({ agent: f.agent, messages: [input], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [input] }))
      await expect(request({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' }))).resolves.toEqual({ provider: 'fixture' })
      expect(f.runtime.budgetState(f.agent)?.run.intent.admission).toMatchObject({ round: 1 })
    } finally { await f.dispose() }
  })

  test('keeps the durable append-before-request ABI and denies a mismatched pre-step bridge', async () => {
    const old = fixture(), invalid = fixture()
    try {
      old.events([{ seq: 1, type: 'turn/start', data: { turn: 2 } }, { seq: 2, type: 'user/message', data: { source: old.source } }])
      old.native.roundsStarted = 1
      old.record.native.roundsStarted = 1
      await expect(old.handlers.get('agent/request')!({ agent: old.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' }))).resolves.toEqual({ provider: 'fixture' })
      expect(old.runtime.budgetState(old.agent)).toBeDefined()

      const pre = invalid.handlers.get('agent/pre-step')!, request = invalid.handlers.get('agent/request')!
      const offered = invalid.message()
      await pre({ agent: invalid.agent, messages: [offered], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [invalid.message({ ...invalid.source, round: 2 })] }))
      await request({ agent: invalid.agent, turn: 2, step: 2, signal: new AbortController().signal }, async () => ({ provider: 'fixture' }))
      expect(invalid.runtime.budgetState(invalid.agent)).toBeUndefined()
    } finally { await old.dispose(); await invalid.dispose() }
  })
})

test('rejects a downstream mutation or multiple offered goal inputs instead of bridging them', async () => {
  const f = fixture(), multiple = fixture(), content = fixture()
  try {
    const input: any = f.message()
    await f.handlers.get('agent/pre-step')!({ agent: f.agent, messages: [input], turn: 2, step: 1, signal: new AbortController().signal }, async () => {
      input.source.round = 2
      return { kind: 'enter', messages: [input] }
    })
    await expect(f.handlers.get('agent/request')!({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(f.runtime.budgetState(f.agent)).toBeUndefined()

    const first = multiple.message(), second = multiple.message()
    await multiple.handlers.get('agent/pre-step')!({ agent: multiple.agent, messages: [first, second], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [first, second] }))
    await expect(multiple.handlers.get('agent/request')!({ agent: multiple.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(multiple.runtime.budgetState(multiple.agent)).toBeUndefined()

    const contentInput: any = { id: 'goal-message', role: 'user', content: [{ type: 'text', text: 'offered' }], source: content.source }
    await content.handlers.get('agent/pre-step')!({ agent: content.agent, messages: [contentInput], turn: 2, step: 1, signal: new AbortController().signal }, async () => {
      contentInput.content[0].text = 'rewritten'
      return { kind: 'enter', messages: [contentInput] }
    })
    await expect(content.handlers.get('agent/request')!({ agent: content.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(content.runtime.budgetState(content.agent)).toBeUndefined()
  } finally { await f.dispose(); await multiple.dispose(); await content.dispose() }
})

test('consumes the bridge on an abort, wrong request identity, or changed native authority', async () => {
  const aborted = fixture(), wrong = fixture(), changed = fixture()
  try {
    const abort = new AbortController()
    const preAborted = aborted.handlers.get('agent/pre-step')!
    await preAborted({ agent: aborted.agent, messages: [aborted.message()], turn: 2, step: 1, signal: abort.signal }, async () => ({ kind: 'enter', messages: [aborted.message()] }))
    abort.abort()
    await expect(aborted.handlers.get('agent/request')!({ agent: aborted.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(aborted.runtime.budgetState(aborted.agent)).toBeUndefined()

    const preWrong = wrong.handlers.get('agent/pre-step')!
    await preWrong({ agent: wrong.agent, messages: [wrong.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [wrong.message()] }))
    await expect(wrong.handlers.get('agent/request')!({ agent: wrong.agent, turn: 2, step: 2, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('native round is not current')
    expect(() => wrong.runtime.budgetState(wrong.agent)).toThrow('cancelled execution cannot resume')

    const preChanged = changed.handlers.get('agent/pre-step')!
    await preChanged({ agent: changed.agent, messages: [changed.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [changed.message()] }))
    changed.native.revision += 1
    await expect(changed.handlers.get('agent/request')!({ agent: changed.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('native round is not current')
    expect(() => changed.runtime.budgetState(changed.agent)).toThrow('cancelled execution cannot resume')
  } finally { await aborted.dispose(); await wrong.dispose(); await changed.dispose() }
})

test('does not carry a proof across a rejected pre-step, another turn, request failures, or disposal', async () => {
  const rejected = fixture(), crossed = fixture(), failed = fixture(), disposed = fixture()
  try {
    await rejected.handlers.get('agent/pre-step')!({ agent: rejected.agent, messages: [rejected.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
    await expect(rejected.handlers.get('agent/request')!({ agent: rejected.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(rejected.runtime.budgetState(rejected.agent)).toBeUndefined()

    await crossed.handlers.get('agent/pre-step')!({ agent: crossed.agent, messages: [crossed.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [crossed.message()] }))
    await expect(crossed.handlers.get('agent/request')!({ agent: crossed.agent, turn: 3, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('native round is not current')

    await failed.handlers.get('agent/pre-step')!({ agent: failed.agent, messages: [failed.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [failed.message()] }))
    await expect(failed.handlers.get('agent/request')!({ agent: failed.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => { throw new Error('fixture request failure') }))
      .rejects.toThrow('fixture request failure')
    await expect(failed.handlers.get('agent/request')!({ agent: failed.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('cancelled execution cannot resume')

    await disposed.handlers.get('agent/pre-step')!({ agent: disposed.agent, messages: [disposed.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [disposed.message()] }))
    await disposed.dispose()
    await expect(disposed.handlers.get('agent/request')!({ agent: disposed.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('inactive execution producer')
  } finally { await rejected.dispose(); await crossed.dispose(); await failed.dispose() }
})

test('rejects a pending proof when the native round already advanced before request', async () => {
  const f = fixture()
  try {
    await f.handlers.get('agent/pre-step')!({ agent: f.agent, messages: [f.message()], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [f.message()] }))
    f.native.roundsStarted = 1
    f.record.native.roundsStarted = 1
    await expect(f.handlers.get('agent/request')!({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('native round is not current')
  } finally { await f.dispose() }
})

test('requires the pending modern input to remain the sole durable input through request completion', async () => {
  const f = fixture()
  try {
    const message = f.message()
    await f.handlers.get('agent/pre-step')!({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
    await expect(f.handlers.get('agent/request')!({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => {
      f.events([{ seq: 1, type: 'turn/start', data: { turn: 2 } }, { seq: 2, type: 'user/message', data: { id: 'foreign', role: 'user', content: [{ type: 'text', text: 'foreign' }], source: { kind: 'user' } } }])
      return { provider: 'fixture' }
    })).rejects.toThrow('native round is not current')
  } finally { await f.dispose() }
})

test('does not let a legacy durable message with the same goal source substitute different accepted content', async () => {
  const f = fixture()
  try {
    const offered = { id: 'goal-message', role: 'user' as const, content: [{ type: 'text', text: 'accepted' }], source: f.source }
    await f.handlers.get('agent/pre-step')!({ agent: f.agent, messages: [offered], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [offered] }))
    f.events([{ seq: 1, type: 'turn/start', data: { turn: 2 } }, { seq: 2, type: 'user/message', data: { id: 'goal-message', role: 'user', content: [{ type: 'text', text: 'substituted' }], source: f.source } }])
    f.native.roundsStarted = 1
    f.record.native.roundsStarted = 1
    await expect(f.handlers.get('agent/request')!({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .rejects.toThrow('native round is not current')
  } finally { await f.dispose() }
})


test('propagates a foreign downstream request failure without cancelling or revoking that Agent', async () => {
  const f = fixture()
  try {
    const request = f.handlers.get('agent/request')!
    await expect(request({ agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => {
      throw new Error('foreign child hook failed')
    })).rejects.toThrow('foreign child hook failed')
    expect(f.cancellations()).toBe(0)
    await expect(request({ agent: f.agent, turn: 2, step: 2, signal: new AbortController().signal }, async () => ({ provider: 'fixture' })))
      .resolves.toEqual({ provider: 'fixture' })
    expect(f.runtime.budgetState(f.agent)).toBeUndefined()
  } finally { await f.dispose() }
})
