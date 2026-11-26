import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-ray/assistant-automations'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { CredentialsKeychainService } from '@dsh-ray/credentials-keychain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import eventTriggersPlugin, {
  boundEventIntakeId,
  buildEventIntakeObservation,
  EVENT_OBSERVER_EXECUTOR,
  EVENT_TRIGGERS_INTAKE_SOURCE,
  EventIntakeAdapter,
  EventTriggersService,
  normalizeEventTriggersConfig,
  toWorkItemIntakeInput,
  type EventIntakeObservation,
  type GoalSourceDetachEvent,
} from '../src/index.ts'

const workItemsSource = new URL('../../assistant-work-items/src/index.ts', import.meta.url).href

const roots: string[] = []
const contexts: Context[] = []
const extraFibers: Array<{ dispose(): Promise<void> | void }> = []

afterEach(async () => {
  for (const fiber of extraFibers.splice(0).reverse()) await fiber.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

class MockRepositoryActions extends Service {
  constructor(ctx: Context, readonly readRepositoryEventObservation: (...args: unknown[]) => unknown) {
    super(ctx, 'assistantActions')
  }
}

interface WorkItemsModule {
  AssistantWorkItemsService: new (...args: never[]) => unknown
}

interface WorkItemsServiceLike {
  inspectIntakeQueue(options?: { limit?: number }): {
    intakeCounts: { stored: number; duplicate: number; filtered: number }
  }
}

function readWorkItemIntakeState(root: string) {
  const db = new DatabaseSync(join(root, 'work-items.sqlite'), { readOnly: true })
  try {
    const ledger = db.prepare('SELECT source, source_event_id, decision, reason, strength, strength_reason, signals, content_digest FROM work_item_intake ORDER BY recorded_at, source_event_id').all() as Array<Record<string, unknown>>
    const items = (db.prepare('SELECT count(*) AS n FROM work_item').get() as { n: number }).n
    const dispatches = (db.prepare('SELECT count(*) AS n FROM work_item_dispatch').get() as { n: number }).n
    return { ledger, items, dispatches }
  } finally {
    db.close()
  }
}

async function mountWorkItems(ctx: Context, root: string, options: { unsubscribedEvents?: boolean } = {}) {
  const workItemsModule = await import(workItemsSource) as WorkItemsModule
  const fiber = ctx.plugin(workItemsModule.AssistantWorkItemsService as never, {
    enabled: true,
    mode: 'observe',
    databasePath: join(root, 'work-items.sqlite'),
    workRoot: join(root, 'work-root'),
    intakeLedger: {
      enabled: true,
      sources: {
        [EVENT_TRIGGERS_INTAKE_SOURCE]: {
          unsubscribedEvents: options.unsubscribedEvents ?? false,
        },
      },
    },
  } as never)
  await fiber
  extraFibers.push(fiber)
  return ctx.get('assistantWorkItems' as never) as unknown as WorkItemsServiceLike
}

async function createBaseEnv(options: {
  withCredentials?: boolean
  withActions?: boolean
  goalPhase?: 'paused' | 'active' | 'complete' | 'cleared'
  expiresAt?: number
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-intake-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const scope = {
    principalId: 'owner:one',
    principalRecordId: 'record-1',
    principalVersion: 1,
    workspace: root,
    preset: 'primary',
  }
  const expiresAt = options.expiresAt ?? Date.now() + 120_000
  const owner = {
    ...scope,
    ownerRouteId: 'route-1',
    expiresAt,
    budgetId: 'event-observations',
  }
  let goal = {
    scope,
    id: 'goal-1',
    definition: { version: 1, digest: 'c'.repeat(64) },
    native: { sessionId: 'session-1', goalId: 'native-goal-1', revision: 2, phase: options.goalPhase ?? 'paused' },
  }
  const route = () => Object.freeze({
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
  })
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: vi.fn(route) } as never)
  ctx.provide('assistantGoals' as never, {
    inspectGoalLifecycle: ({ scope: reqScope, goalId }: { scope: typeof scope; goalId: string }) =>
      JSON.stringify(reqScope) === JSON.stringify(goal.scope) && goalId === goal.id
        ? Object.freeze({ ...goal })
        : undefined,
  } as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'event-observations', metric: 'requests', limit: 200, periodMs: 60_000, scope: 'subject' }],
    rules: [
      { id: 'observer-reconcile', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'file-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file-opt-in', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'file-goal-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file-goal', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'file-default-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file-default', workspace: root }, actions: ['observe'], resource: { kind: 'filesystem', id: '*' }, context: { initiators: ['background'] } },
      { id: 'http-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:http-intake', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://api.example.test/status' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'repo-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:repo-ci', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://api.github.com/repos/owner/repo' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'repo-ext-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:repo-commit', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'https://api.github.com/repos/owner/repo' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'calendar-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:calendar-intake', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: 'lark-calendar:cal_owner' }, context: { initiators: ['background'] }, budget: { id: 'event-observations', amount: 1 } },
      { id: 'cred-use', effect: 'allow', subject: { kind: 'background', id: 'dsh-ray-event-triggers' }, actions: ['credential.use'], resource: { kind: 'credential', id: '*' }, context: { initiators: ['background'] } },
      { id: 'ingest-all', effect: 'allow', subject: { kind: 'external', id: '*', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
      { id: 'accept-webhook', effect: 'allow', subject: { kind: 'external', id: 'webhook:webhook-intake' }, actions: ['accept'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
    ],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'),
    runsPath: join(root, 'runs'),
    schedulerEnabled: false,
    reconcileIntervalMs: 0,
    allowUnbudgetedExecution: true,
  })
  if (options.withCredentials) {
    await ctx.plugin({
      name: 'credentials-intake-fixture',
      apply(runtime: Context) {
        new CredentialsKeychainService(runtime, {
          databasePath: join(root, 'credentials.sqlite'),
          handles: [
            { id: 'github', provider: 'environment', environmentName: 'GH_TOKEN', consumers: ['dsh-ray-event-triggers'], purposes: ['github.observe'], maxLeaseMs: 30_000 },
            { id: 'hook-secret', provider: 'environment', environmentName: 'WEBHOOK_SECRET', consumers: ['dsh-ray-event-triggers'], purposes: ['verify-webhook'], maxLeaseMs: 30_000 },
          ],
        }, { env: { GH_TOKEN: 'ghp_intake_secret_never_leak', WEBHOOK_SECRET: 'whsec_intake_secret_never_leak' } })
      },
    })
  }
  if (options.withActions) {
    let commitCall = 0
    await ctx.plugin({
      name: 'repo-actions-intake-fixture',
      apply(runtime: Context) {
        new MockRepositoryActions(runtime, async () => {
          commitCall += 1
          return Object.freeze({
            protocol: 'assistant-actions/repository-event/v1' as const,
            fingerprint: `sha256:${sha256(`commit-state-${commitCall}`)}`,
            truthy: true as const,
          })
        })
      },
    })
  }
  const claimFor = (triggerId: string, automationId: string, configDigest: string) => ({
    triggerId,
    scope,
    goalId: goal.id,
    definition: goal.definition,
    native: { sessionId: goal.native.sessionId, goalId: goal.native.goalId, revision: goal.native.revision },
    configDigest,
    automationId,
  })
  return {
    root,
    ctx,
    scope,
    owner,
    claimFor,
    getGoal: () => goal,
    setGoalPhase: (phase: 'paused' | 'active' | 'complete' | 'cleared', revision = goal.native.revision + 1) => {
      goal = { ...goal, native: { ...goal.native, revision, phase } }
    },
    emitGoalChanged: (operation: 'complete' | 'clear', overrides: { sessionId?: string; goalId?: string; cwd?: string; preset?: string } = {}) => {
      const target = {
        agent: {
          session: {
            id: overrides.sessionId ?? goal.native.sessionId,
            header: { cwd: overrides.cwd ?? root, agentPreset: overrides.preset ?? scope.preset },
          },
        },
        change: {
          operation,
          ref: { id: overrides.goalId ?? goal.native.goalId },
          goal: { id: overrides.goalId ?? goal.native.goalId, phase: operation === 'complete' ? 'complete' : 'cleared' },
        },
      }
      ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit('goal/changed', target)
    },
  }
}

describe('event-triggers normalized intake adapter & WP11 unsubscribe lifecycle', () => {
  it('validates intake opt-in config strictly and preserves config digest when omitted or disabled', async () => {
    const env = await createBaseEnv()
    const filePath = join(env.root, 'watched.txt')
    await writeFile(filePath, 'v1')

    expect(() => normalizeEventTriggersConfig({
      databasePath: join(env.root, 'events.sqlite'),
      allowedFileRoots: [env.root],
      triggers: [{
        id: 'file-no-observer',
        kind: 'file',
        automationId: 'file-task',
        path: filePath,
        intake: { enabled: true },
      }],
    })).toThrow(/requires an observer owner/i)

    expect(() => normalizeEventTriggersConfig({
      databasePath: join(env.root, 'events.sqlite'),
      allowedFileRoots: [env.root],
      triggers: [{
        id: 'file-bad-label',
        kind: 'file',
        automationId: 'file-task',
        path: filePath,
        observer: env.owner,
        intake: { enabled: true, summaryLabel: 'bad\u0007label' },
      }],
    })).toThrow(/summaryLabel/i)

    const omittedConfig = {
      databasePath: join(env.root, 'events-omitted.sqlite'),
      allowedFileRoots: [env.root],
      pollerEnabled: false,
      triggers: [{
        id: 'file-opt-in',
        kind: 'file' as const,
        automationId: 'file-task',
        path: filePath,
        observer: env.owner,
      }],
    }
    const disabledConfig = {
      databasePath: join(env.root, 'events-disabled.sqlite'),
      allowedFileRoots: [env.root],
      pollerEnabled: false,
      triggers: [{
        ...omittedConfig.triggers[0]!,
        intake: { enabled: false },
      }],
    }
    let snap1!: { configDigest: string }
    const f1 = env.ctx.plugin(runtime => {
      const s1 = new EventTriggersService(runtime, omittedConfig)
      snap1 = s1.sourceSnapshot('file-opt-in')
    })
    await f1
    await f1.dispose()
    const s2 = new EventTriggersService(env.ctx, disabledConfig)
    const snap2 = s2.sourceSnapshot('file-opt-in')
    expect(snap1.configDigest).toBe(snap2.configDigest)

    const enabled = normalizeEventTriggersConfig({
      ...disabledConfig,
      triggers: [{ ...omittedConfig.triggers[0]!, intake: { enabled: true, summaryLabel: 'build log' } }],
    })
    expect(enabled.triggers[0]?.intake).toEqual({ enabled: true, subscribed: true, summaryLabel: 'build log' })
  })

  it('normalizes bounded observations, verifies optional text digest, projects closed WorkItemIntakeInput, and deduplicates', () => {
    const longEventId = 'e'.repeat(400)
    const boundedId = boundEventIntakeId('trig-one', longEventId)
    expect(Buffer.byteLength(boundedId, 'utf8')).toBeLessThanOrEqual(256)
    expect(boundedId).toBe(boundEventIntakeId('trig-one', longEventId))

    const normalizedTrigger = normalizeEventTriggersConfig({
      databasePath: '/tmp/unused-unit-test.sqlite',
      allowedFileRoots: ['/tmp'],
      triggers: [{
        id: 'file-unit',
        kind: 'file',
        automationId: 'auto-unit',
        path: '/tmp/watched.txt',
        observer: {
          principalId: 'owner:one',
          principalRecordId: 'record-1',
          principalVersion: 1,
          workspace: '/tmp',
          preset: 'primary',
          ownerRouteId: 'route-1',
          expiresAt: Date.now() + 60_000,
          budgetId: 'budget-1',
        },
        intake: { enabled: true, summaryLabel: 'a'.repeat(160) },
      }],
    }).triggers[0]!
    const receipt = Object.freeze({
      principalRecordId: 'record-1',
      principalVersion: 1,
      principalId: 'owner:one',
      workspace: '/tmp',
      agentPreset: 'primary',
      bindingVersion: 1,
      generation: 1,
      authorityId: 'route-1',
      authorityHash: 'a'.repeat(64),
      receiptVersion: 2 as const,
    })
    const validText = 'verified-file-observation'
    const obsDigest = sha256(validText)
    const envelopeDigest = 'b'.repeat(64)
    const envelope = Object.freeze({
      protocol: 'dsh-external-event/v1' as const,
      source: { id: 'event-triggers:file-unit', kind: 'file' as const, version: '0.1.74', configDigest: 'c'.repeat(64) },
      event: { id: longEventId, occurredAt: 1_700_000_000_000, receivedAt: 1_700_000_000_100 },
      observation: { digest: obsDigest, revision: 'r1', timeBasis: 'observed' as const },
      trust: { method: 'local-observation' as const, content: 'untrusted' as const },
      target: { automationId: 'auto-unit' },
      deduplicationKey: 'dedup',
    })

    const matched = buildEventIntakeObservation({
      trigger: normalizedTrigger,
      receipt,
      sequence: 1,
      envelope,
      envelopeDigest,
      text: validText,
    })
    expect(matched.source).toBe(EVENT_TRIGGERS_INTAKE_SOURCE)
    expect(matched.kind).toBe('event')
    expect(matched.sender).toBe('owner:one')
    expect(matched.conversation).toEqual({ kind: 'event-source', chat: 'file-unit', workspace: '/tmp', preset: 'primary' })
    expect(Buffer.byteLength(matched.summary, 'utf8')).toBeLessThanOrEqual(280)
    expect(matched.text).toBe(validText)

    const tampered = buildEventIntakeObservation({
      trigger: normalizedTrigger,
      receipt,
      sequence: 1,
      envelope,
      envelopeDigest,
      text: 'forged-text-not-matching-digest',
    })
    expect(tampered.text).toBeUndefined()

    const workItemInput = toWorkItemIntakeInput(matched)
    expect(Object.keys(workItemInput).sort()).toEqual([
      'addressed',
      'contentDigest',
      'kind',
      'occurredAt',
      'senderAllowlisted',
      'senderIsBot',
      'source',
      'sourceEventId',
      'subscribed',
      'threadFollowUp',
    ])

    const seen: EventIntakeObservation[] = []
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new EventIntakeAdapter(ctx, { protocol: 1, observe: obs => seen.push(obs) })
    expect(adapter.emit(matched)).toBe(true)
    expect(adapter.emit({ ...matched })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('emits deduplicated intake into AssistantWorkItems only when opted in across file, http-json, and webhook triggers with zero secret leakage', async () => {
    const env = await createBaseEnv({ withCredentials: true })
    const workItems = await mountWorkItems(env.ctx, env.root, { unsubscribedEvents: false })
    const optInFile = join(env.root, 'opt-in.txt')
    const defaultFile = join(env.root, 'default.txt')
    await writeFile(optInFile, 'initial-a')
    await writeFile(defaultFile, 'initial-b')

    let httpBody = { version: 1, secretToken: 'raw-body-secret-never-emit' }
    let now = 1_700_000_000_000
    const observations: EventIntakeObservation[] = []

    let service!: EventTriggersService
    const serviceFiber = await env.ctx.plugin({
      name: 'dsh-ray-event-triggers',
      apply(runtime: Context) {
        service = new EventTriggersService(runtime, {
          databasePath: join(env.root, 'events.sqlite'),
          allowedFileRoots: [env.root],
          allowedHttpHosts: ['api.example.test'],
          pollerEnabled: false,
          requestTimeoutMs: 1_000,
          triggers: [
            {
              id: 'file-opt-in',
              kind: 'file',
              automationId: 'auto-file-opt-in',
              path: optInFile,
              debounceMs: 0,
              cooldownMs: 0,
              observer: env.owner,
              intake: { enabled: true, summaryLabel: 'file-signal' },
            },
            {
              id: 'file-default',
              kind: 'file',
              automationId: 'auto-file-default',
              path: defaultFile,
              debounceMs: 0,
              cooldownMs: 0,
              observer: env.owner,
            },
            {
              id: 'http-intake',
              kind: 'http-json',
              automationId: 'auto-http',
              url: 'https://api.example.test/status',
              pointer: '/version',
              debounceMs: 0,
              cooldownMs: 0,
              observer: env.owner,
              intake: { enabled: true, subscribed: false, summaryLabel: 'api-check' },
            },
            {
              id: 'webhook-intake',
              kind: 'webhook',
              automationId: 'auto-hook',
              credentialHandle: 'hook-secret',
              cooldownMs: 0,
              observer: env.owner,
              intake: { enabled: true, summaryLabel: 'ci-hook' },
            },
          ],
        }, {
          now: () => now,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetcher: async () => new Response(JSON.stringify(httpBody), { status: 200 }),
          intakeObserver: { protocol: 1, observe: obs => observations.push(obs) },
        })
      },
    })
    extraFibers.push(serviceFiber)

    // Baseline poll captures initial state without emitting change edges
    await service.pollOnce()
    expect(observations).toHaveLength(0)

    // Trigger file-opt-in (subscribed=true), file-default (intake off), and http-intake (subscribed=false)
    await writeFile(optInFile, 'updated-a')
    await writeFile(defaultFile, 'updated-b')
    httpBody = { version: 2, secretToken: 'raw-body-secret-never-emit' }
    await service.pollOnce()

    // Polling again without change emits zero duplicates
    await service.pollOnce()

    // Signed webhook observation
    const body = Buffer.from(JSON.stringify({ build: 'green' }))
    const ts = String(now)
    const nonce = 'nonce-1'
    const sig = `sha256=${createHmac('sha256', 'whsec_intake_secret_never_leak').update(`${ts}\n${nonce}\n`).update(body).digest('hex')}`
    await service.ingestWebhook('webhook-intake', {
      timestamp: ts,
      nonce,
      signature: sig,
      body,
    })

    expect(observations.map(item => item.triggerId).sort()).toEqual(['file-opt-in', 'http-intake', 'webhook-intake'])
    for (const obs of observations) {
      const serialized = JSON.stringify(obs)
      expect(serialized).not.toContain('raw-body-secret-never-emit')
      expect(serialized).not.toContain('whsec_intake_secret_never_leak')
    }

    const { ledger, items, dispatches } = readWorkItemIntakeState(env.root)
    // file-opt-in & webhook-intake are stored (`subscribed: true`), http-intake is filtered (`subscribed: false` & policy off)
    expect(ledger).toHaveLength(3)
    const fileRow = ledger.find(row => String(row.source_event_id).startsWith('file-opt-in/'))
    const httpRow = ledger.find(row => String(row.source_event_id).startsWith('http-intake/'))
    const hookRow = ledger.find(row => String(row.source_event_id).startsWith('webhook-intake/'))
    expect(fileRow).toMatchObject({ source: EVENT_TRIGGERS_INTAKE_SOURCE, decision: 'stored', strength: 'inferred' })
    expect(JSON.parse(String(fileRow?.signals))).toMatchObject({ subscribed: true })
    expect(httpRow).toMatchObject({ source: EVENT_TRIGGERS_INTAKE_SOURCE, decision: 'filtered', reason: 'unsubscribed-event-disabled' })
    expect(JSON.parse(String(httpRow?.signals))).toMatchObject({ subscribed: false })
    expect(hookRow).toMatchObject({ source: EVENT_TRIGGERS_INTAKE_SOURCE, decision: 'stored', strength: 'inferred' })
    expect(workItems.inspectIntakeQueue().intakeCounts).toEqual({ stored: 2, duplicate: 0, filtered: 1 })
    // Zero automatic work-item creation or dispatch from passive event intake alone
    expect(items).toBe(0)
    expect(dispatches).toBe(0)

    await env.ctx.fiber.restart()
  })

  it('emits normalized intake observations from github-repository (PR/CI + external commit) and lark-calendar sensors', async () => {
    const env = await createBaseEnv({ withCredentials: true, withActions: true })
    const workItems = await mountWorkItems(env.ctx, env.root)
    const observations: EventIntakeObservation[] = []
    let conclusion = 'success'
    let calendarSummary = 'standup'

    let service!: EventTriggersService
    const serviceFiber = await env.ctx.plugin({
      name: 'dsh-ray-event-triggers',
      apply(runtime: Context) {
        service = new EventTriggersService(runtime, {
          databasePath: join(env.root, 'events.sqlite'),
          pollerEnabled: false,
          requestTimeoutMs: 1_000,
          triggers: [
            {
              id: 'repo-ci',
              kind: 'github-repository',
              automationId: 'auto-repo-ci',
              repository: 'owner/repo',
              branch: 'feat/p3',
              baseBranch: 'main',
              credentialHandle: 'github',
              debounceMs: 0,
              cooldownMs: 0,
              observer: env.owner,
              intake: { enabled: true, summaryLabel: 'pr-ci' },
            },
            {
              id: 'repo-commit',
              kind: 'github-repository',
              automationId: 'auto-repo-commit',
              repository: 'owner/repo',
              branch: 'feat/p3',
              baseBranch: 'main',
              deliveryMode: 'commit',
              fireWhen: 'changed',
              externalGrant: { id: 'grant-1', revision: 1, digest: 'e'.repeat(64) },
              debounceMs: 0,
              cooldownMs: 0,
              observerLifetime: 'goal',
              observer: env.owner,
              intake: { enabled: true, summaryLabel: 'commit-watch' },
            },
            {
              id: 'calendar-intake',
              kind: 'lark-calendar',
              automationId: 'auto-calendar',
              calendarId: 'cal_owner',
              startTime: 1,
              endTime: 10_000,
              debounceMs: 0,
              cooldownMs: 0,
              observer: env.owner,
              intake: { enabled: true, summaryLabel: 'schedule' },
            },
          ],
        }, {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          fetcher: async (url) => {
            const path = new URL(url).pathname
            if (path.includes('/branches/')) return new Response(JSON.stringify({ name: 'feat/p3', commit: { sha: 'a'.repeat(40) } }), { status: 200 })
            if (path.includes('/check-runs')) return new Response(JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'CI', app: { id: 7 }, head_sha: 'a'.repeat(40), status: 'completed', conclusion }] }), { status: 200 })
            if (path.endsWith('/pulls')) return new Response(JSON.stringify([{ number: 9, state: 'open', head: { ref: 'feat/p3', sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } } }]), { status: 200 })
            return new Response(JSON.stringify([{ id: 1, user: { id: 42 }, commit_id: 'a'.repeat(40), state: 'APPROVED' }]), { status: 200 })
          },
          larkCalendarReader: {
            async readCalendarEventPage() {
              return {
                has_more: false,
                items: [{ event_id: 'evt-1', summary: calendarSummary, start_time: { timestamp: '100' }, end_time: { timestamp: '200' }, status: 'confirmed' }],
              }
            },
          },
          intakeObserver: { protocol: 1, observe: obs => observations.push(obs) },
        })
      },
    })
    extraFibers.push(serviceFiber)

    // Baseline poll: repo-commit has truthy external observation so it fires immediately when goal claim exists or baseline stores; repo-ci & calendar baseline silently
    await service.pollOnce()
    const beforeCount = observations.length

    conclusion = 'failure'
    calendarSummary = 'incident-review'
    await service.pollOnce()

    const emitted = observations.slice(beforeCount)
    expect(emitted.some(item => item.triggerId === 'repo-ci' && item.triggerKind === 'github-repository' && item.summary.includes('mode=pull-request'))).toBe(true)
    expect(emitted.some(item => item.triggerId === 'calendar-intake' && item.triggerKind === 'lark-calendar' && item.summary.includes('calendar=cal_owner'))).toBe(true)
    expect(observations.some(item => item.triggerId === 'repo-commit' && item.summary.includes('mode=commit'))).toBe(true)
    for (const obs of observations) {
      expect(JSON.stringify(obs)).not.toContain('ghp_intake_secret_never_leak')
      expect(JSON.stringify(obs)).not.toContain('incident-review')
    }
    expect(workItems.inspectIntakeQueue().intakeCounts.stored).toBeGreaterThanOrEqual(3)
    expect(readWorkItemIntakeState(env.root).ledger).toHaveLength(3)
  })

  it('detaches goal-scoped sources cleanly on goal/changed, expiry, and unsubscribeGoalSources while preserving shared sources and durability across restart', async () => {
    const env = await createBaseEnv({ goalPhase: 'paused' })
    const goalFile = join(env.root, 'goal-watched.txt')
    const sharedFile = join(env.root, 'shared-watched.txt')
    await writeFile(goalFile, 'v1')
    await writeFile(sharedFile, 'v1')

    const serviceConfig = {
      databasePath: join(env.root, 'events.sqlite'),
      allowedFileRoots: [env.root],
      pollerEnabled: false,
      triggers: [
        {
          id: 'file-goal',
          kind: 'file' as const,
          automationId: 'auto-goal-file',
          path: goalFile,
          debounceMs: 0,
          cooldownMs: 0,
          observerLifetime: 'goal' as const,
          observer: env.owner,
          intake: { enabled: true },
        },
        {
          id: 'file-opt-in',
          kind: 'file' as const,
          automationId: 'auto-shared-file',
          path: sharedFile,
          debounceMs: 0,
          cooldownMs: 0,
          observerLifetime: 'shared' as const,
          observer: env.owner,
          intake: { enabled: true },
        },
      ],
    }

    const pluginFiber = await env.ctx.plugin(eventTriggersPlugin, serviceConfig)
    extraFibers.push(pluginFiber)
    const service = env.ctx.get('eventTriggers' as never) as unknown as EventTriggersService
    const goalSnapshot = service.sourceSnapshot('file-goal')
    service.claimGoalSource(env.claimFor('file-goal', 'auto-goal-file', goalSnapshot.configDigest))

    const detachEvents: GoalSourceDetachEvent[] = []
    service.registerUnsubscribeHook(event => detachEvents.push(event))

    const goalListener = vi.fn()
    const sharedListener = vi.fn()
    service.subscribeSourceChanges(goalListener, { triggerId: 'file-goal', goalId: 'goal-1' })
    service.subscribeSourceChanges(sharedListener, { triggerId: 'file-opt-in' })

    // Cross-goal / wrong-scope unsubscribe must NOT touch goal-1 or shared source
    expect(service.unsubscribeGoalSources({ scope: env.scope, goalId: 'other-goal', reason: 'cancelled' })).toEqual([])
    expect(service.unsubscribeGoalSources({ scope: { ...env.scope, principalVersion: 99 }, goalId: 'goal-1', reason: 'cancelled' })).toEqual([])

    // Reactive terminal goal/changed triggers reconcile without polling timers
    env.setGoalPhase('complete')
    env.emitGoalChanged('complete')
    await vi.waitFor(() => expect(detachEvents).toHaveLength(1))
    expect(detachEvents[0]).toMatchObject({ triggerId: 'file-goal', reason: 'completed', goalId: 'goal-1' })
    expect(service.isRetiredGoalSource('file-goal')).toBe(true)

    // Automation was paused cleanly and shared trigger remains unaffected
    expect(env.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'auto-goal-file' }))
      .toMatchObject({ automationStatus: 'paused' })
    expect(env.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'auto-shared-file' }))
      .toMatchObject({ automationStatus: 'active' })

    // Auto-detached goal-scoped change listener no longer receives future notifications, while shared listener does
    await writeFile(sharedFile, 'v2')
    await service.pollOnce()
    expect(goalListener).not.toHaveBeenCalled()
    expect(sharedListener).toHaveBeenCalledTimes(1)

    // Post-restart durability: retired goal source remains retired without polling new file mutations
    await pluginFiber.dispose()
    const fiber2 = await env.ctx.plugin(eventTriggersPlugin, serviceConfig)
    extraFibers.push(fiber2)
    const restarted = env.ctx.get('eventTriggers' as never) as unknown as EventTriggersService
    expect(restarted.isRetiredGoalSource('file-goal')).toBe(true)
    const lateIntake: EventIntakeObservation[] = []
    restarted.registerIntakeObserver({ protocol: 1, observe: obs => lateIntake.push(obs) })
    await writeFile(goalFile, 'v2-after-retire')
    await restarted.pollOnce()
    expect(lateIntake.some(obs => obs.triggerId === 'file-goal')).toBe(false)
  })

  it('aborts pending observations on source detach, handles clear/expiry cleanup, and cleans up disposers on service stop', async () => {
    const startNow = Date.now()
    const env = await createBaseEnv({ goalPhase: 'paused', expiresAt: startNow + 5_000 })
    let enteredFetch!: () => void
    const fetchStarted = new Promise<void>(resolve => { enteredFetch = resolve })
    let abortedReason: unknown

    const service = new EventTriggersService(env.ctx, {
      databasePath: join(env.root, 'events.sqlite'),
      allowedHttpHosts: ['api.example.test'],
      pollerEnabled: false,
      requestTimeoutMs: 5_000,
      triggers: [{
        id: 'http-intake',
        kind: 'http-json',
        automationId: 'auto-http-goal',
        url: 'https://api.example.test/status',
        pointer: '/version',
        debounceMs: 0,
        cooldownMs: 0,
        observerLifetime: 'goal',
        observer: env.owner,
        intake: { enabled: true },
      }],
    }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async (_url, init) => {
        enteredFetch()
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedReason = init.signal?.reason
            reject(abortedReason)
          }, { once: true })
        })
      },
    })

    const detachEvents: GoalSourceDetachEvent[] = []
    service.registerUnsubscribeHook(event => detachEvents.push(event))

    const pollPromise = service.pollOnce().catch(error => error)
    await fetchStarted

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startNow + 10_000)
    try {
      const detached = service.unsubscribeGoalSources({ scope: env.scope, goalId: 'goal-1', reason: 'expired' })
      expect(detached).toEqual(['http-intake'])
      expect(detachEvents).toHaveLength(1)
      expect(detachEvents[0]).toMatchObject({ triggerId: 'http-intake', reason: 'expired', goalId: 'goal-1' })
      const result = await pollPromise
      expect(abortedReason).toMatchObject({ code: 'source-changed' })
      expect(result).toMatchObject({ code: 'source-changed' })
    } finally {
      nowSpy.mockRestore()
    }

    await env.ctx.fiber.dispose()
    expect(() => service.registerIntakeObserver({ protocol: 1, observe: () => {} })).toThrow(/disposed/i)
    expect(() => service.registerUnsubscribeHook(() => {})).toThrow(/disposed/i)
  })

  it('bridges when EventTriggers starts before AssistantWorkItems and detaches cleanly when WorkItems stops', async () => {
    const env = await createBaseEnv()
    const watched = join(env.root, 'reverse-order.txt')
    await writeFile(watched, 'v1')

    let service!: EventTriggersService
    const eventFiber = await env.ctx.plugin({
      name: 'dsh-ray-event-triggers',
      apply(runtime: Context) {
        service = new EventTriggersService(runtime, {
          databasePath: join(env.root, 'events.sqlite'),
          allowedFileRoots: [env.root],
          pollerEnabled: false,
          triggers: [{
            id: 'file-opt-in',
            kind: 'file',
            automationId: 'auto-file-opt-in',
            path: watched,
            debounceMs: 0,
            cooldownMs: 0,
            observer: env.owner,
            intake: { enabled: true, summaryLabel: 'reverse-order' },
          }],
        })
      },
    })
    extraFibers.push(eventFiber)

    const workItemsModule = await import(workItemsSource) as WorkItemsModule
    const wiFiber = env.ctx.plugin(workItemsModule.AssistantWorkItemsService as never, {
      enabled: true,
      mode: 'observe',
      databasePath: join(env.root, 'work-items.sqlite'),
      workRoot: join(env.root, 'work-root'),
      intakeLedger: { enabled: true },
    } as never)
    await wiFiber
    extraFibers.push(wiFiber)

    await service.pollOnce()
    await writeFile(watched, 'v2')
    await service.pollOnce()
    expect(readWorkItemIntakeState(env.root).ledger).toHaveLength(1)

    await wiFiber.dispose()
    await writeFile(watched, 'v3')
    await service.pollOnce()
    expect(readWorkItemIntakeState(env.root).ledger).toHaveLength(1)
  })
})
