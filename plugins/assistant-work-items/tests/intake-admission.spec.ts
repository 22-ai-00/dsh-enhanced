import { Context, Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantWorkItemsService,
  classifyIntake,
  type Config,
  intakeDecisionFor,
  intakeDecisionIdFor,
  normalizeConfig,
  type WorkItemIntakeEvaluatorRegistration,
  type WorkItemIntakeInput,
  WorkItemIntakeAdmissionBridge,
} from '../src/index.ts'
import type { IntakeAdmitConfig, NormalizedIntakeAdmit } from '../src/config.ts'
import type { PeerOwnerRouteReceipt } from '../src/peers.ts'
import { WorkItemStore } from '../src/store.ts'
import { WorkItemError } from '../src/types.ts'
import { harness, type Harness } from './fixtures.ts'

// WP21 slice 3: accepting WP20 evaluations become execute decisions. Every
// evaluator is a scripted in-process supplier; nothing calls a model.
const RULE = 'triage'
const TEXT = 'the build is red again, can someone look'
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const contexts: Array<{ ctx: Context; root: string }> = []

afterEach(async () => {
  for (const { ctx, root } of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

function input(overrides: Partial<WorkItemIntakeInput> = {}): WorkItemIntakeInput {
  // Allowlisted but unaddressed: graded `inferred`, the only evaluated strength.
  return { source: 'lark-channel', sourceEventId: 'om_1', kind: 'message', senderAllowlisted: true, addressed: false,
    threadFollowUp: false, senderIsBot: false, contentDigest: sha256(TEXT), occurredAt: 1_700_000_000_000, ...overrides }
}

function admitConfig(overrides: Partial<NormalizedIntakeAdmit> = {}): NormalizedIntakeAdmit {
  return { enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-origin-1', maxPerHour: 5, ...overrides }
}

/** One stored inferred row plus its persisted evaluation, as WP20 writes them. */
function evaluated(fixture: Harness, eventId = 'om_1', options: { wouldAccept?: boolean; ruleId?: string; policyVersion?: string } = {}) {
  const digest = sha256(`${TEXT} ${eventId}`)
  if (fixture.store.getIntake('lark-channel', eventId) === undefined) fixture.store.recordIntake(classifyIntake(input({ sourceEventId: eventId, contentDigest: digest })))
  const level = options.wouldAccept === false ? 'notify' : 'accept'
  return fixture.store.recordIntakeEvaluation({
    source: 'lark-channel', sourceEventId: eventId, ruleId: options.ruleId ?? RULE, policyVersion: options.policyVersion ?? 'v1', sourceDigest: digest,
    mode: 'observe', status: 'decided', level, proposedLevel: level, ceiling: 'accept', quoteSpans: [], reasons: [],
    wouldAccept: options.wouldAccept !== false, attempts: 1, decidedAt: fixture.now(),
  }).record
}

function bridge(fixture: Harness, config: NormalizedIntakeAdmit = admitConfig(), admit = (decision: Parameters<Harness['admission']['admitDecision']>[0]) => fixture.admission.admitDecision(decision)) {
  const logs: string[] = []
  const instance = new WorkItemIntakeAdmissionBridge({ config, maxPerRun: 5, store: () => fixture.store, admit, log: message => { logs.push(message) }, now: fixture.now })
  return { instance, logs }
}

async function allowing(ruleId: string | undefined = RULE) {
  const fixture = await harness()
  fixture.policy.decision = { effect: 'allow', reasonCode: 'rule-allow', ...(ruleId === undefined ? {} : { ruleId }) }
  return fixture
}

const items = (fixture: Harness) => fixture.store.countItemsSince(0)

describe('intake admission config', () => {
  const base = (admit: unknown, overrides: Partial<Config> = {}) => normalizeConfig({
    enabled: true, mode: 'active', databasePath: '/tmp/items.sqlite', workRoot: '/tmp/work', workerAutomationId: 'worker', admission: { allowedKinds: ['triage'] },
    scope: { workspace: '/w', preset: 'primary', principalId: 'owner:me', ownerRouteId: 'route', expiresAt: 2_000_000_000_000 },
    intakeLedger: { enabled: true, evaluation: { enabled: true, ...(admit === undefined ? {} : { admit }) } }, ...overrides,
  } as Config, 1_700_000_000_000)

  test('absent or disabled admit normalizes away; enabled defaults to observe', () => {
    expect(base(undefined).intakeLedger?.evaluation?.admit).toBeUndefined()
    expect(base({ enabled: false, mode: 'auto' }).intakeLedger?.evaluation?.admit).toBeUndefined()
    expect(base({ enabled: true, originBindingId: 'binding-1' }).intakeLedger?.evaluation?.admit)
      .toEqual({ enabled: true, mode: 'observe', kind: 'intake-inferred', originBindingId: 'binding-1', maxPerHour: 5 })
  })

  test('auto needs an active intake, an allowed kind and a binding; unknown keys are rejected', () => {
    expect(base({ enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-1' }).intakeLedger?.evaluation?.admit?.mode).toBe('auto')
    const invalid = (admit: unknown, overrides: Partial<Config> = {}) => expect(() => base(admit, overrides)).toThrow(expect.objectContaining({ code: 'invalid-input' }))
    invalid({ enabled: true, mode: 'auto', originBindingId: 'binding-1' })
    invalid({ enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-1' }, { mode: 'observe' })
    invalid({ enabled: true, mode: 'auto', kind: 'triage' })
    invalid({ enabled: true, originBindingId: 'bad binding' })
    invalid({ enabled: true, originBindingId: 'binding-1', maxPerHour: 0 })
    invalid({ enabled: true, originBindingId: 'binding-1', retry: true })
    // Observe records only, so it does not need an active intake.
    expect(base({ enabled: true, originBindingId: 'binding-1' }, { mode: 'observe' }).intakeLedger?.evaluation?.admit?.mode).toBe('observe')
  })
})

describe('intake admission bridge', () => {
  test('auto admits one inferred item per accepting evaluation under a deterministic decision id', async () => {
    const fixture = await allowing()
    const evaluation = evaluated(fixture)
    evaluated(fixture, 'om_2', { wouldAccept: false })
    const { instance } = bridge(fixture)
    const [record, ...rest] = instance.run()
    expect(rest).toEqual([])
    expect(record).toMatchObject({ source: 'lark-channel', sourceEventId: 'om_1', ruleId: RULE, policyVersion: 'v1', mode: 'auto', outcome: 'admitted', reasonCode: null })
    expect(record!.decisionId).toBe(intakeDecisionIdFor(evaluation))
    const item = fixture.store.findItemById(record!.itemId!)!
    expect(item).toMatchObject({ kind: 'triage', state: 'queued', externalId: `decision:${record!.decisionId}`,
      acceptanceRef: 'intake-evaluation:lark-channel/om_1/triage@v1', originBindingId: 'binding-origin-1' })
    expect(item.authority?.ruleId).toBe(RULE)
    expect(item.authority?.mandate).toMatchObject({ origin: 'inferred', mode: 'auto', ruleId: RULE, budgetRemaining: 5 })
    // Metadata only: the inbound text never reaches the mandate.
    expect(JSON.stringify(item)).not.toContain('build is red')
    expect(fixture.store.listIntakeAdmissions('lark-channel', 'om_1')).toEqual([record])
    expect(fixture.store.listIntakeAdmissions('lark-channel', 'om_2')).toEqual([])
    expect(items(fixture)).toBe(1)
  })

  test('the decision id is stable over source, event, rule and Policy version', () => {
    const key = { source: 'lark-channel', sourceEventId: 'om_1', ruleId: RULE, policyVersion: 'v1' }
    expect(intakeDecisionIdFor(key)).toBe(intakeDecisionIdFor({ ...key }))
    expect(intakeDecisionIdFor(key)).toMatch(/^intake:[0-9a-f]{64}$/)
    for (const changed of [{ source: 'other' }, { sourceEventId: 'om_2' }, { ruleId: 'escalate' }, { policyVersion: 'v2' }]) {
      expect(intakeDecisionIdFor({ ...key, ...changed })).not.toBe(intakeDecisionIdFor(key))
    }
  })

  test('replay and a new bridge never decide the same evaluation twice', async () => {
    const fixture = await allowing()
    evaluated(fixture)
    const first = bridge(fixture).instance.run()
    expect(first).toHaveLength(1)
    const admit = vi.fn((decision: Parameters<Harness['admission']['admitDecision']>[0]) => fixture.admission.admitDecision(decision))
    const restarted = bridge(fixture, admitConfig(), admit).instance
    expect(restarted.run()).toEqual([])
    expect(restarted.run()).toEqual([])
    expect(admit).not.toHaveBeenCalled()
    expect(items(fixture)).toBe(1)
  })

  test('an admission whose outcome row was lost replays the same item on the next wake', async () => {
    const fixture = await allowing()
    const evaluation = evaluated(fixture)
    // The crash window: admitted, but the outcome row was never written.
    const lost = fixture.admission.admitDecision(intakeDecisionFor(evaluation, admitConfig(), 5))
    expect(lost.outcome).toBe('admitted')
    const [record] = bridge(fixture).instance.run()
    expect(record).toMatchObject({ outcome: 'replayed', itemId: lost.outcome === 'refused' ? null : lost.item.id })
    expect(items(fixture)).toBe(1)
  })

  test('observe records would-admit and admits nothing; a later auto bridge does not act on it', async () => {
    const fixture = await allowing()
    evaluated(fixture)
    const admit = vi.fn()
    const [record] = bridge(fixture, admitConfig({ mode: 'observe' }), admit).instance.run()
    expect(record).toMatchObject({ mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null })
    expect(admit).not.toHaveBeenCalled()
    expect(bridge(fixture).instance.run()).toEqual([])
    expect(items(fixture)).toBe(0)
    expect(fixture.store.countIntakeAdmitted(0)).toBe(0)
  })

  test('the hourly budget refuses as budget-exhausted, finally, and rolls with the window', async () => {
    const fixture = await allowing()
    evaluated(fixture, 'om_1')
    fixture.advance(1)
    evaluated(fixture, 'om_2')
    const { instance } = bridge(fixture, admitConfig({ maxPerHour: 1 }))
    expect(instance.run().map(record => [record.sourceEventId, record.outcome, record.reasonCode]))
      .toEqual([['om_1', 'admitted', null], ['om_2', 'refused', 'budget-exhausted']])
    // A refusal is final: no retry storm once budget returns.
    fixture.advance(3_600_001)
    evaluated(fixture, 'om_3')
    expect(instance.run().map(record => [record.sourceEventId, record.outcome])).toEqual([['om_3', 'admitted']])
    expect(instance.run()).toEqual([])
    expect(items(fixture)).toBe(2)
    expect(fixture.policy.requests).toHaveLength(2)
  })

  test('Policy allowing under another rule refuses as policy-rule-mismatch without authorizing', async () => {
    const fixture = await allowing('broad-allow')
    evaluated(fixture)
    const { instance } = bridge(fixture)
    expect(instance.run()).toMatchObject([{ outcome: 'refused', reasonCode: 'policy-rule-mismatch', itemId: null }])
    expect(instance.run()).toEqual([])
    expect(fixture.policy.requests).toHaveLength(0)
    expect(items(fixture)).toBe(0)
  })

  test('an ordinary gate or identity error is a final refusal under its code', async () => {
    const fixture = await allowing()
    evaluated(fixture, 'om_1')
    expect(bridge(fixture, admitConfig({ kind: 'deploy' })).instance.run()).toMatchObject([{ outcome: 'refused', reasonCode: 'kind-rejected' }])
    const squatted = evaluated(fixture, 'om_2')
    const changed = intakeDecisionFor(squatted, admitConfig(), 5)
    fixture.admission.admitDecision({ ...changed, mandate: { ...changed.mandate, brief: 'Something else.' } })
    expect(bridge(fixture).instance.run()).toMatchObject([{ sourceEventId: 'om_2', outcome: 'refused', reasonCode: 'identity-mismatch' }])
    fixture.policy.deny('rule-deny')
    evaluated(fixture, 'om_3')
    expect(bridge(fixture).instance.run()).toMatchObject([{ sourceEventId: 'om_3', outcome: 'refused', reasonCode: 'source-rejected' }])
    expect(items(fixture)).toBe(1)
  })

  test('a storage fault defers once, logs once, and admits on a later wake', async () => {
    const fixture = await allowing()
    evaluated(fixture)
    let fault = true
    const { instance, logs } = bridge(fixture, admitConfig(), decision => {
      if (fault) throw new WorkItemError('storage', 'database is locked')
      return fixture.admission.admitDecision(decision)
    })
    expect(instance.run()).toEqual([])
    expect(instance.run()).toEqual([])
    expect(logs).toEqual(['assistant-work-items: intake admission deferred: database is locked'])
    expect(instance.lastError()).toBe('database is locked')
    expect(fixture.store.listIntakeAdmissions('lark-channel', 'om_1')).toEqual([])
    fault = false
    expect(instance.run()).toMatchObject([{ outcome: 'admitted' }])
    expect(items(fixture)).toBe(1)
  })

  test('the admission ledger is append-only and needs an accepting evaluation', async () => {
    const fixture = await allowing()
    const rejected = evaluated(fixture, 'om_1', { wouldAccept: false })
    const key = { source: rejected.source, sourceEventId: rejected.sourceEventId, ruleId: rejected.ruleId, policyVersion: rejected.policyVersion, decisionId: intakeDecisionIdFor(rejected) }
    expect(() => fixture.store.recordIntakeAdmission({ ...key, mode: 'observe', outcome: 'would-admit', reasonCode: null, itemId: null }))
      .toThrow(expect.objectContaining({ code: 'invalid-state' }))
    evaluated(fixture, 'om_2')
    bridge(fixture, admitConfig({ mode: 'observe' })).instance.run()
    const db = new DatabaseSync(fixture.config.databasePath)
    try {
      expect(() => db.exec("UPDATE work_item_intake_admission SET outcome = 'admitted'")).toThrow(/append-only/)
      expect(() => db.exec('DELETE FROM work_item_intake_admission')).toThrow(/append-only/)
      // An observe row can never carry an item or a refusal.
      expect(() => db.exec(`INSERT INTO work_item_intake_admission VALUES ('lark-channel', 'om_1', 'triage', 'v1', 'observe', 'admitted', NULL, 'x', NULL, 1)`)).toThrow()
    } finally {
      db.close()
    }
  })
})

class PolicyPeer extends Service {
  ruleId = RULE
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow' as const, reasonCode: 'rule-allow', ruleId: this.ruleId } }
  evaluate() { return this.authorize() }
}

class SchedulerPeer extends Service {
  readonly listeners = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  onSchedulerWake(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  wake(): void { for (const listener of Array.from(this.listeners)) listener() }
  ingestExternal(value: { automationId: string; eventId: string }) { return { id: `occ-${value.eventId}`, automationId: value.automationId } }
}

/** A scripted supplier whose one rule may reach `accept`. */
function supplier(): WorkItemIntakeEvaluatorRegistration {
  return { protocol: 1, policy: () => ({ version: 'v1', rules: [{ ruleId: RULE, ceiling: 'accept' }] }), evaluate: () => Promise.resolve({ level: 'accept', quotes: ['someone look'] }) }
}

async function serviceSetup(admit: IntakeAdmitConfig | undefined, options: { mode?: 'active' | 'observe'; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'work-items-intake-admission-'))
  const ctx = new Context()
  contexts.push({ ctx, root })
  ctx.provide('assistantDelivery' as never, {
    isMaintenanceDraining: () => true,
    validateOwnerRoute(value: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): PeerOwnerRouteReceipt {
      return { receiptVersion: 2, ...value, authorityHash: 'sha256:owner', principalRecordId: 'owner-1', principalVersion: 1, bindingVersion: 1, generation: 1 }
    },
    enqueueBackground: () => Promise.resolve({ id: 'outbox' }),
  } as never)
  await ctx.plugin(PolicyPeer)
  await ctx.plugin(SchedulerPeer)
  const databasePath = join(root, 'items.sqlite')
  const config: Config = { enabled: true, mode: options.mode ?? 'active', databasePath, workRoot: join(root, 'work'), workerAutomationId: 'worker',
    scope: { workspace: root, preset: 'primary', principalId: 'owner:one', ownerRouteId: 'route', expiresAt: Date.now() + 86_400_000 },
    admission: { allowedKinds: ['triage'], maxOpenItems: 100, maxAdmitsPerHour: 100, cooldownMs: 0 },
    intakeLedger: { enabled: true, evaluation: { enabled: true, ...(admit === undefined ? {} : { admit }) } } }
  await ctx.plugin(AssistantWorkItemsService, config)
  const service = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService
  const scheduler = ctx.get('assistantAutomations' as never) as unknown as SchedulerPeer
  service.registerIntakeEvaluator(supplier())
  return { ctx, root, databasePath, service, scheduler }
}

const rows = (path: string, sql: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all() as Record<string, unknown>[] } finally { db.close() }
}

describe('intake admission on the scheduler wake', () => {
  test('auto: the wake evaluates then admits once; a restart replays nothing new', async () => {
    const first = await serviceSetup({ enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-origin-1' })
    first.service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(first.service.intakeEvaluations('lark-channel', 'om_1')).toMatchObject([{ wouldAccept: true }]))
    // Admission waits for the next scheduler wake; it owns no loop or timer.
    expect(first.service.intakeAdmissions('lark-channel', 'om_1')).toEqual([])
    first.scheduler.wake()
    await vi.waitFor(() => expect(first.service.intakeAdmissions('lark-channel', 'om_1')).toMatchObject([{ outcome: 'admitted', mode: 'auto' }]))
    first.scheduler.wake()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(first.service.runIntakeAdmission()).toEqual([])
    const items = rows(first.databasePath, 'SELECT kind, state FROM work_item')
    expect(items).toEqual([{ kind: 'triage', state: expect.any(String) }])

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(contexts.find(entry => entry.ctx === first.ctx)!), 1)
    const second = await serviceSetup({ enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-origin-1' }, { root: first.root })
    second.scheduler.wake()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(second.service.runIntakeAdmission()).toEqual([])
    expect(rows(second.databasePath, 'SELECT count(*) AS n FROM work_item')).toEqual([{ n: 1 }])
    expect(second.service.intakeAdmissions('lark-channel', 'om_1')).toHaveLength(1)
  })

  test('inspectIntakeProvenance names the intake judgment behind an auto-admitted item only', async () => {
    const fixture = await serviceSetup({ enabled: true, mode: 'auto', kind: 'triage', originBindingId: 'binding-origin-1' })
    fixture.service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(fixture.service.intakeEvaluations('lark-channel', 'om_1')).toMatchObject([{ wouldAccept: true }]))
    fixture.scheduler.wake()
    await vi.waitFor(() => expect(fixture.service.intakeAdmissions('lark-channel', 'om_1')).toMatchObject([{ outcome: 'admitted' }]))
    const [admission] = fixture.service.intakeAdmissions('lark-channel', 'om_1')
    const [evaluation] = fixture.service.intakeEvaluations('lark-channel', 'om_1')
    const provenance = fixture.service.inspectIntakeProvenance(admission!.itemId!)
    expect(provenance).toEqual({ protocol: 'work-items/intake-provenance/v1', itemId: admission!.itemId, source: 'lark-channel', sourceEventId: 'om_1',
      ruleId: admission!.ruleId, policyVersion: admission!.policyVersion, mode: 'auto', level: evaluation!.level, wouldAccept: true, admittedAt: admission!.recordedAt })
    expect(Object.isFrozen(provenance)).toBe(true)
    expect(JSON.stringify(provenance)).not.toContain(TEXT)
    expect(fixture.service.inspectIntakeProvenance('missing-item')).toBeUndefined()
    expect(fixture.service.inspectIntakeProvenance('')).toBeUndefined()
  })

  test('inspectIntakeProvenance is undefined in observe mode, where no item exists', async () => {
    const fixture = await serviceSetup({ enabled: true, originBindingId: 'binding-origin-1' }, { mode: 'observe' })
    fixture.service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(fixture.service.intakeEvaluations('lark-channel', 'om_1')).toMatchObject([{ wouldAccept: true }]))
    fixture.scheduler.wake()
    await vi.waitFor(() => expect(fixture.service.intakeAdmissions('lark-channel', 'om_1')).toMatchObject([{ outcome: 'would-admit', itemId: null }]))
    expect(rows(fixture.databasePath, "SELECT count(*) AS n FROM work_item_intake_admission WHERE item_id IS NOT NULL")).toEqual([{ n: 0 }])
  })

  test('observe: the wake records would-admit without any work item', async () => {
    const fixture = await serviceSetup({ enabled: true, originBindingId: 'binding-origin-1' }, { mode: 'observe' })
    fixture.service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(fixture.service.intakeEvaluations('lark-channel', 'om_1')).toMatchObject([{ wouldAccept: true }]))
    fixture.scheduler.wake()
    await vi.waitFor(() => expect(fixture.service.intakeAdmissions('lark-channel', 'om_1')).toMatchObject([{ outcome: 'would-admit', itemId: null }]))
    expect(rows(fixture.databasePath, 'SELECT count(*) AS n FROM work_item')).toEqual([{ n: 0 }])
  })

  test('off: evaluation still runs and no admission row or item is written', async () => {
    const fixture = await serviceSetup(undefined)
    fixture.service.recordIntake(input(), TEXT)
    await vi.waitFor(() => expect(fixture.service.intakeEvaluations('lark-channel', 'om_1')).toMatchObject([{ wouldAccept: true }]))
    fixture.scheduler.wake()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.service.runIntakeAdmission()).toEqual([])
    expect(fixture.service.intakeAdmissions('lark-channel', 'om_1')).toEqual([])
    expect(rows(fixture.databasePath, 'SELECT count(*) AS n FROM work_item')).toEqual([{ n: 0 }])
    expect(rows(fixture.databasePath, 'SELECT count(*) AS n FROM work_item_intake_admission')).toEqual([{ n: 0 }])
  })
})

describe('schema 12 migration', () => {
  async function downgraded(statements: string) {
    const root = await mkdtemp(join(tmpdir(), 'work-items-intake-admission-schema-'))
    contexts.push({ ctx: new Context(), root })
    const path = join(root, 'items.sqlite')
    const store = new WorkItemStore(path)
    store.recordIntake(classifyIntake(input()))
    store.close()
    const db = new DatabaseSync(path)
    db.exec(statements)
    db.close()
    return path
  }

  test('schema 11 upgrades additively to 12 and keeps its rows', async () => {
    const path = await downgraded("DROP TABLE work_item_intake_admission; UPDATE work_item_schema_meta SET value = '11' WHERE key = 'schema_version'; PRAGMA user_version = 11;")
    const store = new WorkItemStore(path)
    try {
      expect(store.stats().schemaVersion).toBe(12)
      expect(store.countIntake()).toEqual({ stored: 1, duplicate: 0, filtered: 0 })
      expect(store.pendingIntakeAdmissions(10)).toEqual([])
    } finally {
      store.close()
    }
    expect(rows(path, 'PRAGMA user_version')).toEqual([{ user_version: 12 }])
  })

  test('an admission object under schema 11 or a drifted admission table fails closed', async () => {
    const early = await downgraded("DROP TRIGGER work_item_intake_admission_no_update; DROP TRIGGER work_item_intake_admission_no_delete; UPDATE work_item_schema_meta SET value = '11' WHERE key = 'schema_version'; PRAGMA user_version = 11;")
    expect(() => new WorkItemStore(early)).toThrow(/intake admission object before schema 12/)
    expect(rows(early, 'PRAGMA user_version')).toEqual([{ user_version: 11 }])
    // Its append-only triggers alone are already an unknown object at schema 11.
    const triggers = await downgraded("UPDATE work_item_schema_meta SET value = '11' WHERE key = 'schema_version'; PRAGMA user_version = 11;")
    expect(() => new WorkItemStore(triggers)).toThrow(/unexpected schema object/)
    const drifted = await downgraded('DROP TABLE work_item_intake_admission; CREATE TABLE work_item_intake_admission (source TEXT) STRICT;')
    expect(() => new WorkItemStore(drifted)).toThrow(/intake admission schema differs/)
    const index = await downgraded('DROP INDEX work_item_intake_admission_admitted_idx;')
    expect(() => new WorkItemStore(index)).toThrow(/intake admission schema differs/)
  })
})
