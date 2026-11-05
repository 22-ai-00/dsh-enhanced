import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantWorkItemsService,
  classifyIntake,
  type Config,
  type IntakeModelRequest,
  normalizeConfig,
  type WorkItemIntakeEvaluationPolicy,
  type WorkItemIntakeEvaluatorRegistration,
  type WorkItemIntakeInput,
  WorkItemIntakeEvaluationRuntime,
} from '../src/index.ts'
import type { NormalizedIntakeEvaluation } from '../src/config.ts'
import { WorkItemStore } from '../src/store.ts'

// WP20 stage 3: observe-only model evaluation of stored inferred intake rows.
// Every evaluator here is a scripted in-process supplier; nothing calls a model.
const roots: string[] = []
const closers: Array<() => void> = []
const contexts: Context[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const TEXT = 'the build is red again, can someone look'
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function input(overrides: Partial<WorkItemIntakeInput> = {}): WorkItemIntakeInput {
  // Allowlisted but unaddressed: graded `inferred`, the only evaluated strength.
  return { source: 'lark-channel', sourceEventId: 'om_1', kind: 'message', senderAllowlisted: true, addressed: false,
    threadFollowUp: false, senderIsBot: false, contentDigest: sha256(TEXT), occurredAt: 1_700_000_000_000, ...overrides }
}

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'work-items-intake-evaluation-')); roots.push(root)
  return { databasePath: join(root, 'state', 'items.sqlite'), workRoot: join(root, 'work') }
}

async function evaluationConfig(evaluation: NonNullable<Config['intakeLedger']>['evaluation'] = { enabled: true }): Promise<Config & { databasePath: string }> {
  return { enabled: true, mode: 'observe', ...await paths(), intakeLedger: { enabled: true, ...(evaluation === undefined ? {} : { evaluation }) } }
}

function open(config: Config): AssistantWorkItemsService {
  const service = new AssistantWorkItemsService(new Context(), config)
  closers.push(() => service.close())
  return service
}

/** A scripted supplier: a mutable Policy and a per-call script; every request is recorded. */
function supplier(script: (request: IntakeModelRequest, call: number) => unknown, policy: WorkItemIntakeEvaluationPolicy = {
  version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'notify' }],
}) {
  const calls: IntakeModelRequest[] = []
  const state = { policy }
  const registration: WorkItemIntakeEvaluatorRegistration = {
    protocol: 1,
    policy: () => state.policy,
    evaluate: async request => { calls.push(request); return script(request, calls.length) },
  }
  return { calls, state, registration }
}

function query(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all() as Record<string, unknown>[] } finally { db.close() }
}

const evaluationRows = (path: string) => query(path, 'SELECT * FROM work_item_intake_evaluation ORDER BY policy_version, rule_id')

/** The runtime alone, with a manual clock and manual timers, over a real store. */
async function direct(config: Partial<NormalizedIntakeEvaluation> = {}) {
  const { databasePath } = await paths()
  let now = 1_700_000_000_000
  const timers: Array<{ ms: number; fire: () => void; live: boolean }> = []
  const store = new WorkItemStore(databasePath, { now: () => now })
  closers.push(() => store.close())
  const runtime = new WorkItemIntakeEvaluationRuntime({
    config: { enabled: true, timeoutMs: 1_000, maxConsecutiveFailures: 3, maxPerRun: 5, maxCallsPerHour: 20, ...config },
    store: () => store, log: () => {}, now: () => now,
    setTimer: (ms, fire) => { const timer = { ms, fire, live: true }; timers.push(timer); return () => { timer.live = false } },
  })
  closers.push(() => runtime.close())
  const record = () => store.recordIntake(classifyIntake(input())).record
  const fireTimers = () => { for (const timer of timers.splice(0)) if (timer.live) timer.fire() }
  return { databasePath, store, runtime, record, fireTimers, advance: (ms: number) => { now += ms } }
}

describe('inferred intake evaluation', () => {
  test('a verified verdict is persisted once with quote offsets, never the text', async () => {
    const config = await evaluationConfig()
    const service = open(config)
    const s = supplier(request => request.ruleId === 'triage'
      ? { level: 'digest', quotes: ['build is red'] }
      : { level: 'accept', quotes: ['someone look'] }, { version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'notify' }, { ruleId: 'escalate', ceiling: 'digest' }] })
    service.registerIntakeEvaluator(s.registration)
    expect(service.recordIntake(input(), TEXT).record).toMatchObject({ decision: 'stored', strength: 'inferred' })
    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(2))

    const byRule = Object.fromEntries(service.intakeEvaluations('lark-channel', 'om_1').map(record => [record.ruleId, record]))
    expect(byRule['triage']).toMatchObject({ status: 'decided', mode: 'observe', level: 'digest', proposedLevel: 'digest', ceiling: 'notify',
      quoteSpans: [[4, 16]], reasons: [], wouldAccept: false, attempts: 1, policyVersion: 'v1', sourceDigest: sha256(TEXT) })
    // The model can only lower the Host ceiling.
    expect(byRule['escalate']).toMatchObject({ level: 'digest', proposedLevel: 'accept', reasons: ['upgrade-clamped'], quoteSpans: [[28, 40]] })
    expect(TEXT.slice(4, 16)).toBe('build is red')
    expect(s.calls.map(call => [call.ruleId, call.policyVersion, call.sourceText])).toEqual(expect.arrayContaining([['triage', 'v1', TEXT], ['escalate', 'v1', TEXT]]))
    expect(service.intakeEvaluationHealth()).toMatchObject({ enabled: true, registered: true, policyVersion: 'v1', heldTexts: 1, persisted: { decided: 2, unavailable: 0 } })

    // Observe only: no work item, no dispatch, and the body never reaches disk.
    expect(query(config.databasePath, 'SELECT count(*) AS n FROM work_item')[0]!['n']).toBe(0)
    expect(query(config.databasePath, 'SELECT count(*) AS n FROM work_item_dispatch')[0]!['n']).toBe(0)
    service.close()
    for (const file of [config.databasePath, `${config.databasePath}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from('build is red'))).toBe(false)
    }
  })

  test('a quote that is not a substring of the authenticated text downgrades to ignore', async () => {
    const service = open(await evaluationConfig())
    service.registerIntakeEvaluator(supplier(() => ({ level: 'notify', quotes: ['build is green'] })).registration)
    service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    expect(service.intakeEvaluations('lark-channel', 'om_1')[0]).toMatchObject({
      status: 'decided', level: 'ignore', proposedLevel: 'notify', quoteSpans: [], reasons: ['quote-not-in-source'], wouldAccept: false,
    })
  })

  test('text that does not match the stored digest, explicit rows and filtered rows are never evaluated', async () => {
    const service = open(await evaluationConfig())
    const s = supplier(() => ({ level: 'digest', quotes: ['build is red'] }))
    service.registerIntakeEvaluator(s.registration)
    service.recordIntake(input({ sourceEventId: 'om_forged' }), `${TEXT}!`)
    service.recordIntake(input({ sourceEventId: 'om_explicit', addressed: true, contentDigest: sha256('x') }), 'x')
    service.recordIntake(input({ sourceEventId: 'om_stranger', senderAllowlisted: false, contentDigest: sha256('y') }), 'y')
    await flush()
    expect(await service.runIntakeEvaluation()).toEqual([])
    expect(s.calls).toHaveLength(0)
    expect(service.intakeEvaluationHealth()).toMatchObject({ heldTexts: 0, persisted: { decided: 0, unavailable: 0 } })
  })

  test('timeouts re-queue with backoff and stop at the consecutive-failure cap', async () => {
    const f = await direct({ maxConsecutiveFailures: 3 })
    const signals: AbortSignal[] = []
    // Never answers: every attempt ends on the injected timer.
    const s = supplier(request => { signals.push(request.signal); return new Promise(() => {}) })
    f.runtime.register(s.registration)
    f.runtime.observe(f.record(), TEXT)
    await flush()
    expect(s.calls).toHaveLength(1)
    f.fireTimers(); await flush()
    expect(signals[0]!.aborted).toBe(true)

    // Backoff: nothing is due until the clock moves.
    expect(await f.runtime.run()).toEqual([])
    expect(s.calls).toHaveLength(1)
    f.advance(1_000)
    let run = f.runtime.run(); await flush(); f.fireTimers()
    expect(await run).toEqual([])
    expect(s.calls).toHaveLength(2)

    f.advance(2_000)
    run = f.runtime.run(); await flush(); f.fireTimers()
    const settled = await run
    expect(s.calls).toHaveLength(3)
    expect(settled).toEqual([expect.objectContaining({ status: 'unavailable', level: 'ignore', proposedLevel: null,
      reasons: ['consecutive-failures'], attempts: 3, wouldAccept: false })])

    // The cap is final for this Policy version: later runs never call again.
    f.advance(3_600_000)
    expect(await f.runtime.run()).toEqual([])
    expect(s.calls).toHaveLength(3)
    expect(f.runtime.health()).toMatchObject({ unavailable: 1, persisted: { decided: 0, unavailable: 1 } })
  })

  test('consecutive evaluator failures record unavailable', async () => {
    const f = await direct({ maxConsecutiveFailures: 2 })
    const s = supplier(() => { throw new Error('provider down') })
    f.runtime.register(s.registration)
    f.runtime.observe(f.record(), TEXT)
    await flush()
    expect(s.calls).toHaveLength(1)
    expect(f.store.listIntakeEvaluations('lark-channel', 'om_1')).toEqual([])
    f.advance(1_000)
    expect(await f.runtime.run()).toEqual([expect.objectContaining({ status: 'unavailable', reasons: ['consecutive-failures'], attempts: 2 })])
    expect(f.store.listIntakeEvaluations('lark-channel', 'om_1')).toEqual([expect.objectContaining({ status: 'unavailable', level: 'ignore', quoteSpans: [] })])
  })

  test('a failure followed by a verdict settles decided and resets the streak', async () => {
    const f = await direct({ maxConsecutiveFailures: 2 })
    const s = supplier((_request, call) => {
      if (call === 1) throw new Error('flaky')
      return { level: 'digest', quotes: ['red again'] }
    })
    f.runtime.register(s.registration)
    f.runtime.observe(f.record(), TEXT)
    await flush()
    f.advance(1_000)
    expect(await f.runtime.run()).toEqual([expect.objectContaining({ status: 'decided', level: 'digest', attempts: 2, quoteSpans: [[13, 22]] })])
  })

  test('a Policy change re-queues under the new version, including one that lands mid-call', async () => {
    const config = await evaluationConfig()
    const service = open(config)
    const s = supplier((request, call) => {
      // The first call sees the Policy move under it; its verdict is discarded.
      if (call === 1) s.state.policy = { version: 'v2', rules: [{ ruleId: 'triage', ceiling: 'digest' }] }
      return { level: 'digest', quotes: ['build is red'], echo: request.policyVersion }
    })
    service.registerIntakeEvaluator(s.registration)
    service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(s.calls).toHaveLength(1))
    await flush()
    expect(service.intakeEvaluations('lark-channel', 'om_1')).toEqual([])
    await service.runIntakeEvaluation()
    expect(s.calls.map(call => [call.policyVersion, call.ceiling])).toEqual([['v1', 'notify'], ['v2', 'digest']])
    expect(service.intakeEvaluations('lark-channel', 'om_1')).toEqual([expect.objectContaining({ policyVersion: 'v2', ceiling: 'digest', level: 'digest' })])

    // A later change between runs re-evaluates the held text; the older row stays (append-only).
    s.state.policy = { version: 'v3', rules: [{ ruleId: 'triage', ceiling: 'notify' }] }
    await service.runIntakeEvaluation()
    expect(s.calls.map(call => call.policyVersion)).toEqual(['v1', 'v2', 'v3'])
    expect(evaluationRows(config.databasePath).map(row => row['policy_version'])).toEqual(['v2', 'v3'])

    // An unreadable Policy evaluates nothing.
    s.state.policy = { version: 'bad version', rules: [] }
    service.recordIntake(input({ sourceEventId: 'om_2' }), TEXT)
    await flush()
    expect(await service.runIntakeEvaluation()).toEqual([])
    expect(s.calls).toHaveLength(3)
    expect(service.intakeEvaluationHealth()).toMatchObject({ policyVersion: null, lastError: 'policy-unavailable' })
  })

  test('replay and restart return the original result without a second call', async () => {
    const config = await evaluationConfig()
    const first = open(config)
    const s = supplier(() => ({ level: 'notify', quotes: ['can someone look'] }))
    first.registerIntakeEvaluator(s.registration)
    first.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(first.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    const original = first.intakeEvaluations('lark-channel', 'om_1')

    // In-process redelivery of the same event.
    expect(first.recordIntake(input(), TEXT).replayed).toBe(true)
    await flush()
    expect(await first.runIntakeEvaluation()).toEqual([])
    first.close()

    // A restarted service re-seeds from the persisted row on redelivery.
    const second = open(config)
    const again = supplier(() => ({ level: 'ignore', quotes: [] }))
    second.registerIntakeEvaluator(again.registration)
    expect(second.recordIntake(input(), TEXT).replayed).toBe(true)
    await flush()
    expect(await second.runIntakeEvaluation()).toEqual([])
    expect(s.calls).toHaveLength(1)
    expect(again.calls).toHaveLength(0)
    expect(second.intakeEvaluations('lark-channel', 'om_1')).toEqual(original)
    expect(second.intakeEvaluationHealth()).toMatchObject({ decided: 1, persisted: { decided: 1, unavailable: 0 } })
    second.close()

    // The store write itself is idempotent and append-only.
    const store = new WorkItemStore(config.databasePath)
    try {
      const { recordedAt: _recordedAt, ...replay } = original[0]!
      expect(store.recordIntakeEvaluation({ ...replay, level: 'accept' })).toEqual({ record: original[0], replayed: true })
      expect(() => store.recordIntakeEvaluation({ ...replay, policyVersion: 'v9', sourceDigest: sha256('other') })).toThrow(/intake/)
    } finally {
      store.close()
    }
    const db = new DatabaseSync(config.databasePath)
    try {
      expect(() => db.exec("UPDATE work_item_intake_evaluation SET level = 'accept'")).toThrow(/append-only/)
      expect(() => db.exec('DELETE FROM work_item_intake_evaluation')).toThrow(/append-only/)
    } finally {
      db.close()
    }
  })

  test('the native scheduler wake drives the same bounded run; no new timer or loop', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const wakes: Array<() => void> = []
    let observer: { acceptsSourceText?: true; observe(signal: unknown): void } | undefined
    ctx.provide('assistantDelivery' as never, { registerInboundIntakeObserver: (value: typeof observer) => { observer = value; return () => {} } } as never)
    ctx.provide('assistantAutomations' as never, { onSchedulerWake: (listener: () => void) => { wakes.push(listener); return () => {} } } as never)
    const config = await evaluationConfig()
    await ctx.plugin(AssistantWorkItemsService, config).await()
    const service = ctx.assistantWorkItems
    expect(wakes).toHaveLength(1)
    expect(observer?.acceptsSourceText).toBe(true)
    let fail = true
    const s = supplier(() => {
      if (fail) throw new Error('first attempt fails')
      return { level: 'digest', quotes: ['build is red'] }
    }, { version: 'v1', rules: [{ ruleId: 'triage', ceiling: 'notify' }] })
    service.registerIntakeEvaluator(s.registration)
    // The observer splits the transient text off before the ledger write.
    observer!.observe({ ...input(), sourceText: TEXT })
    await vi.waitFor(() => expect(s.calls).toHaveLength(1))
    expect(query(config.databasePath, 'SELECT count(*) AS n FROM work_item_intake')[0]!['n']).toBe(1)
    fail = false
    await flush()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 5_000)
      wakes[0]!()
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(service.intakeEvaluations('lark-channel', 'om_1')).toHaveLength(1))
    expect(s.calls).toHaveLength(2)
  })
})

describe('disabled evaluation changes nothing', () => {
  test('without intakeLedger.evaluation there is no observer opt-in, no wake subscription and no evaluation row', async () => {
    expect(normalizeConfig({ enabled: true, mode: 'observe', databasePath: '/tmp/x.sqlite', workRoot: '/tmp/w',
      intakeLedger: { enabled: true, evaluation: { enabled: false } } }, 0).intakeLedger?.evaluation).toBeUndefined()
    const ctx = new Context(); contexts.push(ctx)
    const wakes: Array<() => void> = []
    let observer: { acceptsSourceText?: true; observe(signal: unknown): void } | undefined
    ctx.provide('assistantDelivery' as never, { registerInboundIntakeObserver: (value: typeof observer) => { observer = value; return () => {} } } as never)
    ctx.provide('assistantAutomations' as never, { onSchedulerWake: (listener: () => void) => { wakes.push(listener); return () => {} } } as never)
    const config = await evaluationConfig({ enabled: false })
    await ctx.plugin(AssistantWorkItemsService, config).await()
    const service = ctx.assistantWorkItems
    expect(wakes).toHaveLength(0)
    expect(observer).toBeDefined()
    expect(Object.hasOwn(observer!, 'acceptsSourceText')).toBe(false)
    expect(() => service.registerIntakeEvaluator(supplier(() => ({})).registration)).toThrow(/disabled/)
    expect(service.intakeEvaluationHealth()).toBeUndefined()
    expect(await service.runIntakeEvaluation()).toEqual([])

    // The ledger row is identical with or without the transient text.
    const withText = service.recordIntake(input(), TEXT).record
    const without = service.recordIntake(input({ sourceEventId: 'om_2', contentDigest: sha256('other') })).record
    const shape = (record: typeof withText) => ({ ...record, sourceEventId: '', contentDigest: '', metadataDigest: '', recordedAt: 0 })
    expect(withText.decision).toBe('stored')
    expect(shape(withText)).toEqual(shape(without))
    expect(evaluationRows(config.databasePath)).toEqual([])
  })

  test('enabled but unregistered evaluation holds nothing and writes nothing', async () => {
    const config = await evaluationConfig()
    const service = open(config)
    service.recordIntake(input(), TEXT)
    expect(await service.runIntakeEvaluation()).toEqual([])
    expect(service.intakeEvaluationHealth()).toMatchObject({ registered: false, heldTexts: 0, persisted: { decided: 0, unavailable: 0 } })
    expect(evaluationRows(config.databasePath)).toEqual([])
  })
})

describe('schema 11 migration', () => {
  async function downgraded(statements: string) {
    const config = await evaluationConfig()
    open(config).recordIntake(input())
    for (const close of closers.splice(0)) close()
    const db = new DatabaseSync(config.databasePath)
    db.exec(statements)
    db.close()
    return config
  }

  test('schema 10 upgrades additively to 11 and keeps its intake rows', async () => {
    const config = await downgraded("DROP TABLE work_item_intake_evaluation; UPDATE work_item_schema_meta SET value = '10' WHERE key = 'schema_version'; PRAGMA user_version = 10;")
    const store = new WorkItemStore(config.databasePath)
    try {
      expect(store.stats().schemaVersion).toBe(11)
      expect(store.countIntake()).toEqual({ stored: 1, duplicate: 0, filtered: 0 })
      expect(store.countIntakeEvaluations()).toEqual({ decided: 0, unavailable: 0 })
    } finally {
      store.close()
    }
    expect(query(config.databasePath, 'PRAGMA user_version')).toEqual([{ user_version: 11 }])
  })

  test('an evaluation object under schema 10 or a drifted evaluation table fails closed', async () => {
    const early = await downgraded("DROP TRIGGER work_item_intake_evaluation_no_update; DROP TRIGGER work_item_intake_evaluation_no_delete; UPDATE work_item_schema_meta SET value = '10' WHERE key = 'schema_version'; PRAGMA user_version = 10;")
    expect(() => new WorkItemStore(early.databasePath)).toThrow(/intake evaluation object before schema 11/)
    expect(query(early.databasePath, 'PRAGMA user_version')).toEqual([{ user_version: 10 }])
    // Its append-only triggers alone are already an unknown object at schema 10.
    const triggers = await downgraded("UPDATE work_item_schema_meta SET value = '10' WHERE key = 'schema_version'; PRAGMA user_version = 10;")
    expect(() => new WorkItemStore(triggers.databasePath)).toThrow(/unexpected schema object/)

    const drifted = await downgraded('DROP TABLE work_item_intake_evaluation; CREATE TABLE work_item_intake_evaluation (source TEXT) STRICT;')
    expect(() => new WorkItemStore(drifted.databasePath)).toThrow(/intake evaluation schema differs/)
  })

  test('a newer schema fails closed', async () => {
    const config = await downgraded("UPDATE work_item_schema_meta SET value = '12' WHERE key = 'schema_version'; PRAGMA user_version = 12;")
    expect(() => new WorkItemStore(config.databasePath)).toThrow()
  })
})
