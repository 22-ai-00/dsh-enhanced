import { Context } from '@deepseek-ai/cordis'
import type { HostAutomationDefinition, HostAutomationExecutor, HostAutomationExecutorInput,
  HostAutomationExecutorResult, SystemAutomationReconcileInput } from '@dsh-enhanced/assistant-automations'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { AssistantDreamingService } from '../src/runtime.ts'
import { DreamStore } from '../src/store.ts'
import { assignTicket, matchTickets, rollLottery, type Ticket } from '../src/trigger.ts'

/**
 * These tests mount the real plugin into a real Cordis context, exactly like
 * the Loader does (the package default export is the service class, so the
 * Loader instantiates it with `(ctx, config)`). Host services are faked at
 * their public boundary so the wake path can be driven without a database,
 * model or scheduler. When the sibling `assistant-automations` build output is
 * present, two tests additionally execute the real
 * `HostAutomationExecutorRegistry` so the production result validator runs.
 */

/**
 * Simulates the two Automations behaviours this plugin depends on:
 * - a replayed idempotency key returns the first receipt and never reapplies
 *   the input (`automation_system_reconciles`);
 * - a Host executor registry can be injected to exercise the real registry.
 */
interface ExecutorRegistryLike {
  register(executor: HostAutomationExecutor): () => void
  prove(spec: HostAutomationDefinition['execution']): { available: boolean }
  execute(proof: unknown, input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult>
}

class FakeAutomations {
  readonly reconciles: SystemAutomationReconcileInput[] = []
  readonly executors: HostAutomationExecutor[] = []
  readonly receipts = new Map<string, { inputHash: string; status: string }>()
  currentStatus: 'active' | 'paused' | undefined
  lastDefinition: HostAutomationDefinition | undefined
  failReconcileOnce = false

  constructor(readonly registry?: ExecutorRegistryLike) {}

  registerHostExecutor(executor: HostAutomationExecutor): () => void {
    if (this.registry !== undefined) return this.registry.register(executor)
    this.executors.push(executor)
    return () => { this.executors.splice(this.executors.indexOf(executor), 1) }
  }

  reconcileSystem(input: SystemAutomationReconcileInput): unknown {
    this.lastDefinition = input.definition as HostAutomationDefinition
    if (this.failReconcileOnce) {
      this.failReconcileOnce = false
      throw new Error('assistant-automations: policy denied reconcile')
    }
    const status = input.desiredStatus ?? 'active'
    const inputHash = JSON.stringify({ owner: input.owner, automationId: input.automationId,
      desiredStatus: status, definition: input.definition })
    const prior = this.receipts.get(input.idempotencyKey)
    this.reconciles.push(input)
    if (prior !== undefined) {
      if (prior.inputHash !== inputHash) throw new Error('idempotency-conflict')
      return Object.freeze({ id: input.automationId, status: prior.status })
    }
    this.receipts.set(input.idempotencyKey, { inputHash, status })
    this.currentStatus = status
    return Object.freeze({ id: input.automationId, status })
  }
}

interface Fakes {
  automations: FakeAutomations
  agents: { create?: (...args: never[]) => Promise<never> }
  projection: ReturnType<typeof projection> | undefined
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dream-runtime-'))
  roots.push(path)
  return path
}

function scopeOf(workspace: string) {
  return { workspace, preset: 'primary', principalId: 'owner-1', ownerRouteId: 'route-1' }
}

function enabledConfig(workspace: string, databasePath = join(workspace, 'dream.sqlite'),
  overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    scope: scopeOf(workspace),
    databasePath,
    provider: 'test-provider',
    model: 'test-model',
    budgetId: 'dream-budget',
    budgetAmount: 1,
    baseIntervalMs: 3_600_000,
    ...overrides,
  } as never
}

function projection(activityAt: number) {
  return {
    situation: 'sample failure',
    objective: { status: 'not-achieved' },
    receipt: { objective: { status: 'not-achieved', occurredAt: activityAt } },
  }
}

interface FakeContextOptions {
  withProjection?: boolean
  busy?: boolean
  brokenAgents?: boolean
  automations?: FakeAutomations
}

function fakeContext(options: FakeContextOptions = {}): { ctx: Context; fakes: Fakes } {
  const ctx = new Context()
  contexts.push(ctx)
  const fakes: Fakes = {
    automations: options.automations ?? new FakeAutomations(),
    agents: {},
    projection: undefined,
  }
  if (options.brokenAgents) {
    fakes.agents.create = (async () => { throw new Error('agents service unavailable in test') }) as never
  }
  const activityAt = options.busy === true ? Date.now() : Date.now() - 86_400_000
  const item = projection(activityAt)
  fakes.projection = item
  const items = options.withProjection === false ? [] : [item]
  ctx.provide('assistantAutomations' as never, fakes.automations as never)
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) =>
      Object.freeze({ authorityId: input.authorityId, principalId: input.principalId,
        workspace: input.workspace, agentPreset: input.agentPreset,
        principalRecordId: 'principal-record', principalVersion: 1 }),
    resolveOwnerRoute: () => Object.freeze({ binding: { sessionId: 'owner-session' } }),
    enqueueOwnerNotification: () => Object.freeze({ id: 'out-1' }),
  } as never)
  ctx.provide('assistantEvaluation' as never, {
    canonicalHostScope: (input: { workspace: string; preset: string }) => Object.freeze({ ...input }),
    listTrustedTaskLearningProjections: () => Object.freeze({ items: Object.freeze(items) }),
  } as never)
  ctx.provide('assistantGoals' as never, { inspectOwnerGoals: () => [] } as never)
  ctx.provide('assistantSkills' as never, {
    inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [],
  } as never)
  ctx.provide('agents' as never, fakes.agents as never)
  ctx.provide('sessions' as never, { flush: async () => {} } as never)
  ctx.provide('tools' as never, { schemas: () => [] } as never)
  return { ctx, fakes }
}

function executorInputFromDefinition(definition: HostAutomationDefinition, occurrenceId: string,
  executionMode: 'preview' | 'production' = 'production'): HostAutomationExecutorInput {
  return {
    occurrenceId,
    automationId: `dsh-enhanced-assistant-dreaming:${'lane'.padEnd(40, '0')}`,
    definitionHash: 'a'.repeat(64),
    executionMode,
    targetScope: definition.execution.targetScope,
    principal: definition.principal,
    ownerRouteId: definition.execution.ownerRouteId,
    activationNonce: definition.execution.activationNonce,
    catalogDigest: definition.execution.catalogDigest,
    signal: new AbortController().signal,
  }
}

function executorInput(fakes: Fakes, occurrenceId: string,
  executionMode: 'preview' | 'production' = 'production'): HostAutomationExecutorInput {
  return executorInputFromDefinition(fakes.automations.lastDefinition!, occurrenceId, executionMode)
}

/**
 * LOCAL MIRROR ONLY. The production validator
 * (`assistant-automations` `validateHostExecutorResult`) is not exported from
 * that package's public entry point; the real implementation runs at
 * `HostAutomationExecutorRegistry.execute` before a result leaves the registry.
 * These assertions mirror its four terminal rules so the four plugin wake
 * paths can be checked without the sibling build; the "real registry" tests
 * below run the actual production implementation whenever its `lib` is built.
 */
function assertHostExecutorContract(result: HostAutomationExecutorResult): void {
  const classes = ['none', 'budget', 'cancelled', 'configuration', 'execution', 'infrastructure', 'policy', 'provider', 'timeout', 'unknown']
  const phases = ['none', 'artifact-write', 'agent-creation', 'agent-disposal', 'agent-setup', 'budget-reservation',
    'budget-settlement', 'executor-availability', 'host-execution', 'model-execution', 'preflight',
    'preset-resolution', 'prompt-submission', 'recovery', 'session-flush', 'terminal-commit', 'unknown']
  expect(classes).toContain(result.failureClass)
  expect(phases).toContain(result.failurePhase)
  expect(result.failureCode).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
  const noneTuple = result.failureClass === 'none' && result.failurePhase === 'none' && result.failureCode === 'none'
  const partialNone = result.failureClass === 'none' || result.failurePhase === 'none' || result.failureCode === 'none'
  expect(result.outcome === 'succeeded').toBe(noneTuple)
  expect(noneTuple || !partialNone).toBe(true)
  if (result.sideEffectState !== 'none') expect(result.retryability).toBe('unsafe')
  if (result.sideEffectState === 'none' && result.outcome === 'succeeded') expect(result.retryability).toBe('safe')
  const intervention = result.failureClass === 'configuration' || result.failureClass === 'policy' || result.failureClass === 'budget'
  if (result.sideEffectState === 'none' && intervention) expect(result.retryability).toBe('after-intervention')
}

/** Derive the lane exactly like the runtime does. */
function laneOf(workspace: string, databasePath: string): string {
  return acceptanceDigest({ scope: scopeOf(workspace), databasePath }).slice(0, 40)
}

function seedOf(lane: string, randomSeed?: string): string {
  return randomSeed === undefined
    ? createHash('sha256').update(`assistant-dreaming\0${lane}`).digest('hex')
    : createHash('sha256').update(randomSeed).digest('hex')
}

function occurrenceOf(definitionHash: string, occurrenceId: string): number {
  return Number.parseInt(createHash('sha256')
    .update(`${definitionHash}\0${occurrenceId}`).digest('hex').slice(0, 12), 16)
}

/** A fake Agent service whose one model turn submits one cited idea. */
function dreamingAgents(input: { workspace: string; preset: string; evidenceRef: string }) {
  return {
    create: async (createOptions: {
      setup: (agentCtx: unknown, agent: unknown) => Promise<void>
    }) => {
      let submit: { execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> } | undefined
      const agentCtx = {
        effect: (callback: () => unknown) => { callback(); return () => {} },
        on: () => () => {},
        tools: {
          register: (definition: unknown) => { submit = definition as typeof submit },
          restrict: () => {},
          schemas: () => [{ name: 'dream_submit_ideas' }],
          guard: () => {},
        },
      }
      const session = {
        id: 'dream-session',
        header: { cwd: input.workspace, agentPreset: input.preset },
        snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      }
      const agent = {
        session,
        followup: () => {},
        whenIdle: async () => {
          await submit!.execute({
            ideas: [{ summary: 'Playful idea', detail: 'bounded detail', evidence_refs: [input.evidenceRef] }],
          }, { signal: new AbortController().signal })
        },
        cancel: () => {},
      }
      await createOptions.setup(agentCtx, agent)
      return { agent, dispose: async () => {} }
    },
  }
}

const automationsLib = new URL('../../assistant-automations/lib/host-executors.js', import.meta.url)
const automationsLibAvailable = existsSync(automationsLib)

async function realRegistry(): Promise<{ HostAutomationExecutorRegistry: new () => ExecutorRegistryLike }> {
  return await import(automationsLib.href) as { HostAutomationExecutorRegistry: new () => ExecutorRegistryLike }
}

describe('dormant dreaming plugin', () => {
  test('mounts through the Cordis plugin constructor without a scheduler, database or write', async () => {
    const { ctx, fakes } = fakeContext()
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    await ctx.plugin(AssistantDreamingService, { databasePath } as never)
    expect(ctx.assistantDreaming).toBeDefined()
    expect(ctx.assistantDreaming.health()).toMatchObject({
      enabled: false, scheduler: 'dormant', lastRunAt: null, lastSkipReason: null,
      counts: { runs: 0, ideas: 0, recorded: 0 },
    })
    expect(fakes.automations.reconciles).toHaveLength(0)
    expect(fakes.automations.executors).toHaveLength(0)
    expect(existsSync(databasePath)).toBe(false)
    expect(ctx.assistantDreaming.inspectIdeas()).toEqual([])
  })

  test('stays pending instead of crashing when a Host service is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('assistantAutomations' as never, new FakeAutomations() as never)
    // Inject gating: with missing services the plugin fiber never activates,
    // which is how the Loader defers it in profiles without the dependency
    // cohort. Do not await the fiber: a pending plugin has no load to await.
    const pending = ctx.plugin(AssistantDreamingService, {})
    await Promise.resolve()
    expect(ctx.assistantDreaming).toBeUndefined()
    void pending
  })
})

describe('enabled dreaming plugin', () => {
  test('reconciles one system automation and registers the exact host executor', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    expect(ctx.assistantDreaming.health()).toMatchObject({ enabled: true, scheduler: 'active' })
    expect(fakes.automations.reconciles).toHaveLength(1)
    const reconcile = fakes.automations.reconciles[0]!
    expect(reconcile).toMatchObject({
      owner: 'assistant-dreaming',
      automationId: expect.stringMatching(/^dsh-enhanced-assistant-dreaming:[a-f0-9]{40}$/u),
      desiredStatus: 'active',
    })
    // Active reconcile keys are load-scoped: replaying an old receipt would
    // suppress reactivation after a pause/reload (see the retire regression).
    expect(reconcile.idempotencyKey).toMatch(/^dsh-enhanced-assistant-dreaming:[a-f0-9]{40}:[a-f0-9]{40}:active:[0-9a-f-]{36}$/u)
    expect(reconcile.definition).toMatchObject({
      name: 'Bounded dreaming review',
      schedule: { kind: 'every', anchorAt: '1970-01-01T00:00:00.000Z', intervalMs: 3_600_000 },
      misfire: { kind: 'skip' },
      overlap: 'skip',
      retrySafety: 'never',
      maxRetries: 0,
      workspace,
      agentPreset: 'primary',
      principal: 'owner-1',
      budgetId: 'dream-budget',
      budgetAmount: 1,
      timeoutMs: 90_000,
      execution: {
        kind: 'host', executorId: 'assistant-dreaming-v1', executorContractVersion: 1,
        runbookId: 'dream', runbookVersion: 1,
        targetScope: { workspace, preset: 'primary' },
        ownerRouteId: 'route-1',
        scopeDigest: acceptanceDigest([workspace, 'primary']),
      },
    })
    const definition = reconcile.definition as HostAutomationDefinition
    expect(definition.execution.catalogDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(fakes.automations.executors).toHaveLength(1)
    const executor = fakes.automations.executors[0]!
    expect(executor.accepts({ ...definition.execution, kind: 'host' } as never)).toBe(true)
    expect(executor.accepts({ ...definition.execution, executorId: 'other' } as never)).toBe(false)
    expect(existsSync(join(workspace, 'dream.sqlite'))).toBe(true)
  })

  test('prunes expired ideas on load and keeps fresh ones', async () => {
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    const lane = laneOf(workspace, databasePath)
    const seedStore = new DreamStore(databasePath, lane)
    seedStore.beginDream('run-1', 1, '2020-01-01', 1, 'f'.repeat(64))
    seedStore.recordIdea({
      id: 'old-idea', runId: 'run-1', createdAt: 1, dayKey: '2020-01-01',
      summary: 'expired', detail: 'd', evidenceRefs: ['a'.repeat(64)],
    })
    seedStore.recordIdea({
      id: 'fresh-idea', runId: 'run-1', createdAt: Date.now(), dayKey: '2026-11-13',
      summary: 'fresh', detail: 'd', evidenceRefs: ['b'.repeat(64)],
    })
    seedStore.close()

    const { ctx } = fakeContext()
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    const remaining = ctx.assistantDreaming.inspectIdeas().map(idea => idea.id)
    expect(remaining).toEqual(['fresh-idea'])
    expect(ctx.assistantDreaming.health().counts).toMatchObject({ runs: 1, ideas: 1 })
  })

  test('pauses the automation on retire without deleting the ledger', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    ctx.assistantDreaming.retire()
    expect(ctx.assistantDreaming.health().scheduler).toBe('dormant')
    expect(fakes.automations.reconciles).toHaveLength(2)
    expect(fakes.automations.reconciles[1]!.desiredStatus).toBe('paused')
    expect(fakes.automations.currentStatus).toBe('paused')
    expect(fakes.automations.executors).toHaveLength(0)
    expect(existsSync(join(workspace, 'dream.sqlite'))).toBe(true)
  })

  test('a fresh load with the same config reactivates after retire instead of replaying the old active receipt', async () => {
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    const automations = new FakeAutomations()
    const first = fakeContext({ automations })
    await first.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    expect(automations.currentStatus).toBe('active')
    first.ctx.assistantDreaming.retire()
    expect(automations.currentStatus).toBe('paused')
    expect(automations.executors).toHaveLength(0)

    // Simulate a Host reload with the same config. The old deterministic
    // active key would replay the stale active receipt and leave the row
    // paused while the new service reports an active scheduler.
    const second = fakeContext({ automations })
    await second.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    expect(automations.currentStatus).toBe('active')
    expect(second.ctx.assistantDreaming.health().scheduler).toBe('active')
    expect(automations.executors).toHaveLength(1)
  })

  test('retired -> resume -> retired again ends paused, not stuck active by a replayed paused receipt', async () => {
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    const automations = new FakeAutomations()

    const first = fakeContext({ automations })
    await first.ctx.plugin(AssistantDreamingService,
      enabledConfig(workspace, databasePath, { retired: true }))
    expect(automations.currentStatus).toBe('paused')

    const resumed = fakeContext({ automations })
    await resumed.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    expect(automations.currentStatus).toBe('active')

    // Second retirement uses the same config as the first one. A deterministic
    // paused key would replay the first paused receipt and leave the row
    // active while this load is dormant and has no executor.
    const executorsBefore = automations.executors.length
    const second = fakeContext({ automations })
    await second.ctx.plugin(AssistantDreamingService,
      enabledConfig(workspace, databasePath, { retired: true }))
    expect(automations.currentStatus).toBe('paused')
    expect(second.ctx.assistantDreaming.health().scheduler).toBe('dormant')
    // The paused load must not register a new executor (the resumed load's
    // executor stays registered until its context is disposed in afterEach).
    expect(automations.executors).toHaveLength(executorsBefore)
  })

  test('retire after a reload ends paused, not stuck active by the previous paused receipt', async () => {
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    const automations = new FakeAutomations()

    const first = fakeContext({ automations })
    await first.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    first.ctx.assistantDreaming.retire()
    expect(automations.currentStatus).toBe('paused')

    // Reload the same config: this converges the row back to active with a
    // fresh load nonce. retire() in the new load must pause it again.
    const second = fakeContext({ automations })
    await second.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath))
    expect(automations.currentStatus).toBe('active')
    second.ctx.assistantDreaming.retire()
    expect(automations.currentStatus).toBe('paused')
    expect(automations.executors).toHaveLength(0)
  })

  test('retired:true loads paused with no executor, and clearing it resumes', async () => {
    const workspace = root()
    const automations = new FakeAutomations()
    const paused = fakeContext({ automations })
    await paused.ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, { retired: true }))
    expect(paused.ctx.assistantDreaming.health()).toMatchObject({ enabled: true, scheduler: 'dormant' })
    expect(automations.currentStatus).toBe('paused')
    expect(automations.executors).toHaveLength(0)
    // The owner ledger is still opened so retention keeps running while paused.
    expect(existsSync(join(workspace, 'dream.sqlite'))).toBe(true)

    const resumed = fakeContext({ automations })
    await resumed.ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    expect(automations.currentStatus).toBe('active')
    expect(resumed.ctx.assistantDreaming.health().scheduler).toBe('active')
    expect(automations.executors).toHaveLength(1)
  })

  test('a failed construction releases its executor and ledger so a retry can load', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    fakes.automations.failReconcileOnce = true
    await expect(ctx.plugin(AssistantDreamingService, enabledConfig(workspace))).rejects.toThrow(/reconcile/u)
    // No leaked registration and no leaked open ledger: the Loader keeps this
    // process alive, so the second load must be able to register the same
    // descriptor again.
    expect(fakes.automations.executors).toHaveLength(0)
    // Same Context retry (the Loader reloads in place): a leaked service
    // registration or descriptor would make this throw.
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    expect(fakes.automations.executors).toHaveLength(1)
    expect(ctx.assistantDreaming.health().scheduler).toBe('active')
  })

  test.skipIf(!automationsLibAvailable)('failed construction leaves no descriptor in the real registry and a retry can load', async () => {
    const { HostAutomationExecutorRegistry } = await realRegistry()
    const registry = new HostAutomationExecutorRegistry()
    const automations = new FakeAutomations(registry)
    automations.failReconcileOnce = true
    const workspace = root()
    const { ctx } = fakeContext({ automations })
    await expect(ctx.plugin(AssistantDreamingService, enabledConfig(workspace))).rejects.toThrow(/reconcile/u)
    const definition = automations.lastDefinition!
    expect(registry.prove(definition.execution).available).toBe(false)

    // The real registry rejects a duplicate descriptor, so a same-Context
    // reload proves the failed first load unregistered cleanly.
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    expect(registry.prove(definition.execution).available).toBe(true)
  })

  test('a failed paused reconcile while retiring also cleans up and a retry can load', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    fakes.automations.failReconcileOnce = true
    await expect(ctx.plugin(AssistantDreamingService,
      enabledConfig(workspace, undefined, { retired: true }))).rejects.toThrow(/reconcile/u)
    expect(fakes.automations.executors).toHaveLength(0)
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, { retired: true }))
    expect(fakes.automations.currentStatus).toBe('paused')
    expect(ctx.assistantDreaming.health().scheduler).toBe('dormant')
  })

  test('a preview occurrence is a no-effect success and never reaches the model', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext({ brokenAgents: true })
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace))
    const executor = fakes.automations.executors[0]!
    const result = await executor.execute(executorInput(fakes, 'occ-preview', 'preview'))
    assertHostExecutorContract(result)
    expect(result).toEqual({
      outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
      sideEffectState: 'none', retryability: 'safe',
    })
    expect(ctx.assistantDreaming.health()).toMatchObject({
      lastSkipReason: 'preview', lastRunOutcome: null, counts: { runs: 0, ideas: 0 },
    })
  })

  test('a slot that misses the trigger gate is a no-effect success', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, { runProbabilityPpm: 0 }))
    const executor = fakes.automations.executors[0]!
    const result = await executor.execute(executorInput(fakes, 'occ-gate'))
    assertHostExecutorContract(result)
    expect(result.outcome).toBe('succeeded')
    expect(result.sideEffectState).toBe('none')
    expect(ctx.assistantDreaming.health()).toMatchObject({
      lastSkipReason: 'draw-not-selected', lastRunOutcome: null, counts: { runs: 0, ideas: 0 },
    })
  })

  test('a lottery miss is a no-effect success with zero model calls and zero runs', async () => {
    const workspace = root()
    const databasePath = join(workspace, 'dream.sqlite')
    const { ctx, fakes } = fakeContext({ brokenAgents: true })
    const randomSeed = 'dream-test-seed-0001'
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, databasePath, {
      runProbabilityPpm: 1_000_000, lotteryWindow: 0, randomSeed,
    }))
    const executor = fakes.automations.executors[0]!
    // The material's single item holds the lane's only ticket; find an
    // occurrence whose deterministic draw does not hit it (window 0).
    const lane = laneOf(workspace, databasePath)
    const seedDigest = seedOf(lane, randomSeed)
    const evidenceRef = acceptanceDigest(fakes.projection!).slice(0, 64)
    const ticket: Ticket = assignTicket({ seedDigest, lane, subject: { kind: 'task-projection', key: evidenceRef } })
    let occurrenceId = ''
    for (let index = 0; index < 512; index += 1) {
      const candidate = `occ-miss-${index}`
      const draw = rollLottery({ seedDigest, lane, occurrence: occurrenceOf('a'.repeat(64), candidate) })
      if (matchTickets({ draw, tickets: [ticket], window: 0 }).length === 0) { occurrenceId = candidate; break }
    }
    expect(occurrenceId).not.toBe('')
    const result = await executor.execute(executorInput(fakes, occurrenceId))
    assertHostExecutorContract(result)
    expect(result).toMatchObject({ outcome: 'succeeded', sideEffectState: 'none', retryability: 'safe' })
    expect(ctx.assistantDreaming.health()).toMatchObject({
      lastSkipReason: 'lottery-no-hit', lastRunOutcome: null, counts: { runs: 0, ideas: 0 },
    })
  })

  test('a lottery hit that fails in the agent is a contract-valid failure and leaves an interrupted run', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext({ brokenAgents: true })
    // window 500000 matches every ticket, so the first occurrence always hits.
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, {
      runProbabilityPpm: 1_000_000, lotteryWindow: 500_000,
    }))
    const executor = fakes.automations.executors[0]!
    const result = await executor.execute(executorInput(fakes, 'occ-hit'))
    assertHostExecutorContract(result)
    expect(result).toMatchObject({
      outcome: 'failed', failureClass: 'execution', failurePhase: 'host-execution',
      failureCode: 'dream-execution-failed', sideEffectState: 'possible', retryability: 'unsafe',
    })
    expect(ctx.assistantDreaming.health()).toMatchObject({
      lastRunOutcome: 'failed', counts: { runs: 1, ideas: 0, recorded: 0 },
    })
  })

  test('a lottery hit that submits an idea returns the possible-effect success and persists the idea', async () => {
    const workspace = root()
    const { ctx, fakes } = fakeContext()
    const evidenceRef = acceptanceDigest(fakes.projection!).slice(0, 64)
    fakes.agents.create = (dreamingAgents({
      workspace, preset: 'primary', evidenceRef,
    }).create) as never
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, {
      runProbabilityPpm: 1_000_000, lotteryWindow: 500_000,
    }))
    const executor = fakes.automations.executors[0]!
    const result = await executor.execute(executorInput(fakes, 'occ-dream'))
    assertHostExecutorContract(result)
    expect(result).toEqual({
      outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
      sideEffectState: 'possible', retryability: 'unsafe',
    })
    expect(ctx.assistantDreaming.health()).toMatchObject({
      lastRunOutcome: 'succeeded', counts: { runs: 1, ideas: 1, recorded: 1 },
    })
    expect(ctx.assistantDreaming.inspectIdeas()[0]!.summary).toBe('Playful idea')
  })

  test.skipIf(!automationsLibAvailable)('the real Host registry accepts every terminal this executor returns', async () => {
    const { HostAutomationExecutorRegistry } = await realRegistry()
    const registry = new HostAutomationExecutorRegistry()
    const automations = new FakeAutomations(registry)
    const workspace = root()
    const { ctx } = fakeContext({ automations, brokenAgents: true })
    await ctx.plugin(AssistantDreamingService, enabledConfig(workspace, undefined, {
      runProbabilityPpm: 1_000_000, lotteryWindow: 500_000,
    }))
    const definition = automations.lastDefinition!
    const executed = await registry.execute(registry.prove(definition.execution),
      executorInputFromDefinition(definition, 'occ-real-preview', 'preview'))
    // The registry validates the production contract before returning, so an
    // invalid terminal would throw here.
    expect(executed).toMatchObject({ outcome: 'succeeded', failureCode: 'none', sideEffectState: 'none' })
    const failed = await registry.execute(registry.prove(definition.execution),
      executorInputFromDefinition(definition, 'occ-real-hit'))
    expect(failed).toMatchObject({
      outcome: 'failed', failureClass: 'execution', failureCode: 'dream-execution-failed',
      sideEffectState: 'possible', retryability: 'unsafe',
    })
  })
})

describe('enabled configuration safety', () => {
  test('rejects a non-canonical scope workspace before reconciling anything', () => {
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: 'relative/workspace', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' },
      databasePath: join(root(), 'dream.sqlite'),
      provider: 'p', model: 'm', budgetId: 'b', budgetAmount: 1,
    })).toThrow(/scope\.workspace/u)
  })
})
