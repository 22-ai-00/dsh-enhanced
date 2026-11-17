import { Context, Service } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantWorkItemsService, type Config } from '../src/index.ts'
import type { PeerEventTriggersIntakeObservation, PeerEventTriggersIntakeObserver } from '../src/peers.ts'

const eventTriggersSource = new URL('../../event-triggers/src/index.ts', import.meta.url).href
const proactiveSource = new URL('../../assistant-proactive/src/index.ts', import.meta.url).href

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart().catch(() => {})))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wi-event-bridge-'))
  roots.push(root)
  return root
}

function makeScriptedEvaluatorLlm(): LlmRuntime {
  const ruleOrder = [
    'dsh-intake-calendar-imminent',
    'dsh-intake-file-watch-change',
    'dsh-intake-github-mention-or-review',
    'dsh-intake-webhook-priority',
  ]
  let call = 0
  return {
    stream() {
      const ruleId = ruleOrder[call % ruleOrder.length]!
      call += 1
      const level = ruleId === 'dsh-intake-github-mention-or-review'
        ? 'accept'
        : ruleId === 'dsh-intake-file-watch-change'
          ? 'digest'
          : 'notify'
      const chunks = [
        { type: 'text-delta' as const, index: 0, text: JSON.stringify({ ruleId, level, quotes: ['build failure on main'] }) },
        { type: 'finish' as const, reason: { kind: 'stop' as const } },
      ]
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  } as unknown as LlmRuntime
}

class FakeEventTriggers extends Service {
  readonly observers = new Set<PeerEventTriggersIntakeObserver>()
  registrations = 0
  unregistrations = 0

  constructor(ctx: Context) {
    super(ctx, 'eventTriggers')
  }

  registerIntakeObserver(observer: PeerEventTriggersIntakeObserver): () => void {
    this.registrations += 1
    this.observers.add(observer)
    return () => {
      this.unregistrations += 1
      this.observers.delete(observer)
    }
  }

  emit(observation: PeerEventTriggersIntakeObservation): void {
    for (const observer of Array.from(this.observers)) observer.observe(observation)
  }
}

function makeObservation(
  id: string,
  text: string,
  overrides: Partial<PeerEventTriggersIntakeObservation> = {},
): PeerEventTriggersIntakeObservation {
  return {
    source: 'event-triggers',
    sourceEventId: id,
    kind: 'event',
    senderIsBot: false,
    explicitlyAddressed: false,
    allowlistedSender: true,
    allowlistedFollowUp: false,
    subscribed: true,
    observationDigest: sha256(text),
    occurredAt: 1_700_000_000_000,
    ...overrides,
  }
}

function readIntakeRows(databasePath: string): Record<string, unknown>[] {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return db
      .prepare('SELECT source, source_event_id, kind, decision, reason, strength, content_digest FROM work_item_intake ORDER BY recorded_at, source_event_id')
      .all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

describe('event-triggers -> assistant-work-items Cordis intake bridge', () => {
  test('registers via registerIntakeObserver regardless of mount order, defaults off, and cleans up on dispose/reload', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    contexts.push(ctx)

    // 1. Default-off when intakeLedger is disabled registers no observer.
    let fake!: FakeEventTriggers
    let eventFork = await ctx.plugin({ name: 'fake-event-triggers', apply(child) { fake = new FakeEventTriggers(child) } })
    const disabledWi = await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      databasePath: join(root, 'disabled.sqlite'),
      workRoot: join(root, 'disabled-work'),
    } as Config)
    expect(fake.registrations).toBe(0)
    fake.emit(makeObservation('evt-off', 'ignored when ledger disabled'))
    expect(readIntakeRows(join(root, 'disabled.sqlite'))).toEqual([])
    await disabledWi.dispose()

    // 2. Opted-in intakeLedger registers on existing eventTriggers provider.
    const dbPath = join(root, 'enabled.sqlite')
    const wiFork = await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      databasePath: dbPath,
      workRoot: join(root, 'enabled-work'),
      intakeLedger: { enabled: true },
    } as Config)
    expect(fake.registrations).toBe(1)
    expect(fake.observers.size).toBe(1)

    // Text is ignored when intakeLedger.evaluation is off; unauthenticated text drops safely; duplicate IDs dedup.
    const canary = 'PLAINTEXT_SECRET_NEVER_PERSIST'
    fake.emit(makeObservation('trig-1/1', canary, { text: canary }))
    fake.emit(makeObservation('trig-1/2', 'valid-body', { text: 'tampered-body-mismatch' }))
    expect(readIntakeRows(dbPath)).toHaveLength(2)
    expect(readIntakeRows(dbPath)[0]).toMatchObject({
      source: 'event-triggers',
      source_event_id: 'trig-1/1',
      kind: 'event',
      decision: 'stored',
      strength: 'inferred',
    })
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(canary))).toBe(false)
    }

    // 3. Reloading eventTriggers cleans up old observer and attaches to the new generation.
    await eventFork.dispose()
    expect(fake.unregistrations).toBe(1)
    let fake2!: FakeEventTriggers
    eventFork = await ctx.plugin({ name: 'fake-event-triggers', apply(child) { fake2 = new FakeEventTriggers(child) } })
    expect(fake2.registrations).toBe(1)
    fake2.emit(makeObservation('trig-1/3', 'reloaded body'))
    expect(readIntakeRows(dbPath)).toHaveLength(3)

    // 4. Disposing WorkItems unregisters observer via ctx.effect disposer.
    await wiFork.dispose()
    expect(fake2.unregistrations).toBe(1)
    expect(fake2.observers.size).toBe(0)
    fake2.emit(makeObservation('trig-1/4', 'post-dispose body'))
    expect(readIntakeRows(dbPath)).toHaveLength(3)
  })

  test('bridges real EventTriggers sensors -> WorkItems ledger and obeys WP11 goal/changed unsubscribe', async () => {
    const root = await tempRoot()
    const ctx = new Context()
    contexts.push(ctx)

    const scope = {
      principalId: 'owner:one',
      principalRecordId: 'record-1',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    let goalPhase: 'paused' | 'complete' = 'paused'

    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: () => Object.freeze({
        authorityId: 'route-1',
        authorityHash: 'a'.repeat(64),
        receiptVersion: 2 as const,
        principalId: scope.principalId,
        principalRecordId: scope.principalRecordId,
        principalVersion: scope.principalVersion,
        workspace: root,
        agentPreset: scope.preset,
        bindingVersion: 1,
        generation: 1,
      }),
      registerInboundIntakeObserver: () => () => {},
      enqueueBackground: async () => ({ id: 'outbox-1' }),
    } as never)

    ctx.provide('assistantGoals' as never, {
      inspectGoalLifecycle: ({ scope: reqScope, goalId }: { scope: typeof scope; goalId: string }) =>
        JSON.stringify(reqScope) === JSON.stringify(scope) && goalId === 'goal-1'
          ? Object.freeze({
            scope,
            id: 'goal-1',
            definition: { version: 1, digest: 'c'.repeat(64) },
            native: { sessionId: 'session-1', goalId: 'native-goal-1', revision: 2, phase: goalPhase },
          })
          : undefined,
    } as never)

    const eventTriggersMod = await import(eventTriggersSource) as {
      EVENT_OBSERVER_EXECUTOR: string
      EVENT_TRIGGERS_INTAKE_SOURCE: string
      EventTriggersService: new (...args: unknown[]) => {
        claimGoalSource(input: unknown): boolean
        pollOnce(): Promise<void>
        isRetiredGoalSource(triggerId: string): boolean
        sourceSnapshot(triggerId: string): { configDigest: string }
      }
    }

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [{ id: 'event-observations', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }],
      rules: [
        { id: 'observer-reconcile', effect: 'allow', subject: { kind: 'background', id: eventTriggersMod.EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        { id: 'file-goal-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file-goal', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
        { id: 'file-shared-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file-shared', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
        { id: 'ingest-all', effect: 'allow', subject: { kind: 'external', id: '*', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
      ],
    })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'),
      schedulerEnabled: false,
      reconcileIntervalMs: 0,
      allowUnbudgetedExecution: true,
    })

    const wiDb = join(root, 'work-items.sqlite')
    await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      scope: {
        workspace: root,
        preset: 'primary',
        principalId: scope.principalId,
        ownerRouteId: 'route-1',
        expiresAt: Date.now() + 120_000,
      },
      databasePath: wiDb,
      workRoot: join(root, 'work-root'),
      intakeLedger: {
        enabled: true,
        sources: {
          [eventTriggersMod.EVENT_TRIGGERS_INTAKE_SOURCE]: { unsubscribedEvents: true },
        },
      },
    } as Config)

    const goalFile = join(root, 'goal-watch.txt')
    const sharedFile = join(root, 'shared-watch.txt')
    await writeFile(goalFile, 'v1')
    await writeFile(sharedFile, 'v1')
    const owner = { ...scope, ownerRouteId: 'route-1', expiresAt: Date.now() + 120_000, budgetId: 'event-observations' }
    let eventService!: InstanceType<typeof eventTriggersMod.EventTriggersService>
    await ctx.plugin({
      name: 'dsh-enhanced-event-triggers',
      apply(runtime) {
        eventService = new eventTriggersMod.EventTriggersService(runtime, {
          databasePath: join(root, 'events.sqlite'),
          allowedFileRoots: [root],
          pollerEnabled: false,
          triggers: [
            {
              id: 'file-goal',
              kind: 'file',
              automationId: 'auto-goal',
              path: goalFile,
              debounceMs: 0,
              cooldownMs: 0,
              observerLifetime: 'goal',
              observer: owner,
              intake: { enabled: true, summaryLabel: 'goal-watch' },
            },
            {
              id: 'file-shared',
              kind: 'file',
              automationId: 'auto-shared',
              path: sharedFile,
              debounceMs: 0,
              cooldownMs: 0,
              observerLifetime: 'shared',
              observer: owner,
              intake: { enabled: true, summaryLabel: 'shared-watch' },
            },
          ],
        })
      },
    })

    const goalSnap = eventService.sourceSnapshot('file-goal')
    eventService.claimGoalSource({
      triggerId: 'file-goal',
      automationId: 'auto-goal',
      configDigest: goalSnap.configDigest,
      scope,
      goalId: 'goal-1',
      definition: { version: 1, digest: 'c'.repeat(64) },
      native: { sessionId: 'session-1', goalId: 'native-goal-1', revision: 2 },
    })

    // Baseline poll, then sensor edge -> arrives in WorkItems intakeLedger via Cordis registerIntakeObserver bridge.
    await eventService.pollOnce()
    await writeFile(goalFile, 'v2')
    await eventService.pollOnce()
    expect(readIntakeRows(wiDb)).toHaveLength(1)
    expect(readIntakeRows(wiDb)[0]).toMatchObject({ source: 'event-triggers', decision: 'stored', strength: 'inferred' })

    // Terminal goal/changed (WP11) retires file-goal automatically so further goal-file edits emit zero intake rows.
    goalPhase = 'complete'
    ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('goal/changed', {
      agent: { session: { id: 'session-1', header: { cwd: root, agentPreset: scope.preset } } },
      change: { operation: 'complete', ref: { id: 'native-goal-1' }, goal: { id: 'native-goal-1', phase: 'complete' } },
    })
    await vi.waitFor(() => expect(eventService.isRetiredGoalSource('file-goal')).toBe(true))
    await writeFile(goalFile, 'v3-ignored')
    await writeFile(sharedFile, 'v2-shared')
    await eventService.pollOnce()
    const rowsAfterRetire = readIntakeRows(wiDb)
    expect(rowsAfterRetire.filter(row => String(row['source_event_id']).startsWith('file-goal/'))).toHaveLength(1)
    expect(rowsAfterRetire.some(row => String(row['source_event_id']).startsWith('file-shared/'))).toBe(true)
  })

  test('evaluates verified event-triggers observations with AssistantProactive balanced preset and syncs into Evaluation schema 19', async () => {
    const root = await tempRoot()
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
      registerInboundIntakeObserver: () => () => {},
    } as never)
    ctx.provide('llm' as never, makeScriptedEvaluatorLlm() as never)

    let fakeEvents!: FakeEventTriggers
    await ctx.plugin({ name: 'fake-event-triggers', apply(child) { fakeEvents = new FakeEventTriggers(child) } })

    const proactiveMod = await import(proactiveSource) as { default: unknown }

    const wiDb = join(root, 'wi-eval.sqlite')
    await ctx.plugin(AssistantWorkItemsService, {
      enabled: true,
      mode: 'observe',
      scope: {
        workspace: root,
        preset: 'primary',
        principalId: 'owner:one',
        ownerRouteId: 'route-1',
        expiresAt: Date.now() + 120_000,
      },
      databasePath: wiDb,
      workRoot: join(root, 'work-root'),
      intakeLedger: {
        enabled: true,
        evaluation: { enabled: true, timeoutMs: 5_000, maxConsecutiveFailures: 3, maxPerRun: 8, maxCallsPerHour: 20 },
      },
    } as Config)

    await ctx.plugin(proactiveMod.default as never, {
      databasePath: ':memory:',
      intakeEvaluation: {
        enabled: true,
        preset: 'balanced',
        provider: 'local-script',
        model: 'scripted-evaluator',
      },
    } as never)

    await ctx.plugin(AssistantEvaluationService, {
      databasePath: join(root, 'evaluation.sqlite'),
      projectionIntervalMs: 0,
      intakeEvaluationAgreementEnabled: true,
    })

    const verifiedText = 'URGENT @reviewer please fix build failure on main PR #42'
    fakeEvents.emit(makeObservation('github-pr-42/1', verifiedText, { text: verifiedText }))

    const workItems = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService
    await vi.waitFor(() => expect(workItems.intakeEvaluations('event-triggers', 'github-pr-42/1')).toHaveLength(4))

    for (const file of [wiDb, `${wiDb}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(verifiedText))).toBe(false)
    }

    const evaluation = ctx.get('assistantEvaluation' as never) as unknown as AssistantEvaluationService
    const synced = evaluation.reconcileIntakeEvaluationAgreement()
    expect(synced).toMatchObject({ enabled: true, available: true, ingested: 4, revised: 4, invalid: 0 })
    const feedAgreed = evaluation.inspectIntakeEvaluationAgreement({
      source: 'event-triggers',
      sourceEventId: 'github-pr-42/1',
      ruleId: 'dsh-intake-github-mention-or-review',
      policyVersion: workItems.intakeEvaluationHealth()!.policyVersion!,
    })
    expect(feedAgreed?.head).toMatchObject({
      source: 'event-triggers',
      ruleId: 'dsh-intake-github-mention-or-review',
      wouldAccept: true,
      agreementStatus: 'pending',
    })
  })
})
