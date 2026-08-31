import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantAutomationsError,
  AssistantAutomationsService,
} from '../src/service.ts'
import { AutomationStore, AutomationStoreError } from '../src/store.ts'
import type { AgentAutomationDefinition, AutomationRun } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(`automations-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

function definition(): AgentAutomationDefinition {
  return {
    name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model', allowedTools: [],
    timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0, misfire: { kind: 'latest' }, overlap: 'skip',
    retrySafety: 'never', maxRetries: 0, principal: 'owner:lark:123',
  }
}

function systemHostDefinition() {
  return {
    name: 'Supervised growth v2', schedule: { kind: 'at' as const, at: '2035-01-01T00:00:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', timeoutMs: 60_000,
    misfire: { kind: 'latest' as const }, overlap: 'skip' as const,
    retrySafety: 'never' as const, maxRetries: 0, principal: 'owner:lark:123',
    execution: {
      kind: 'host' as const, executorId: 'assistant-recovery', executorContractVersion: 2,
      runbookId: 'supervised-growth/v2', runbookVersion: 2,
      catalogDigest: 'a'.repeat(64), targetScope: { workspace: '/work/alpha', preset: 'primary' },
      scopeDigest: '0'.repeat(64), ownerRouteId: 'lark/main/tenant/owner', activationNonce: 'activation-1',
    },
  }
}

function proposedDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at' as const, at: '2030-01-01T00:00:00.000Z' },
    allowedTools: [],
    ...overrides,
  }
}

const proposalDefaults = {
  provider: 'trusted-provider', model: 'trusted-model', allowedTools: ['evolution_review'],
  timeoutMs: 30_000, maxOutputTokens: 256, maxToolCalls: 1,
  misfireKind: 'latest' as const, misfireLimit: 1, overlap: 'skip' as const,
  retrySafety: 'never' as const, maxRetries: 0,
  budgetId: 'growth-budget', budgetAmount: 1,
}

async function harness(allow = true, options: {
  deliveryRoute?: false | { sourceId: string; bindingId: string; workspace: string; principal: string }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-service-'))
  roots.push(root)
  const ctx = new Context()
  const prepareAgentApproval = vi.fn(() => options.deliveryRoute === false
    ? (() => { throw new Error('disabled') })()
    : options.deliveryRoute ?? {
        sourceId: 'dsh-enhanced-assistant-automations', bindingId: 'binding-owner',
        workspace: '/work/alpha', principal: 'lark/main/tenant/owner',
      })
  if (options.deliveryRoute !== false) {
    ctx.provide('assistantDelivery' as never, { prepareAgentApproval } as never)
  }
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'growth-budget', metric: 'automation-runs', limit: 100, periodMs: 60_000, scope: 'subject' }],
    rules: allow ? [
      {
        id: 'allow-agent-automations', effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['history', 'list', 'propose', 'run-dry'], resource: { kind: 'automation', id: '*' },
      },
      {
        id: 'allow-background-automations', effect: 'allow',
        subject: { kind: 'background', id: '*' }, actions: ['execute', 'reconcile', 'repair', 'run-dry'], resource: { kind: 'automation', id: '*' },
        context: { initiators: ['background'] },
      },
      {
        id: 'allow-test-event', effect: 'allow', subject: { kind: 'external', id: 'event-test' },
        actions: ['ingest'], resource: { kind: 'automation', id: 'auto-review' }, context: { initiators: ['external'] },
      },
    ] : [],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
    proposalDefaults,
    allowUnbudgetedExecution: true,
  })
  return { ctx, root, service: ctx.assistantAutomations, prepareAgentApproval }
}

describe('assistant automations Cordis service', () => {
  test('defaults audited route capabilities, requires hard budgets, and exposes bounded trusted proposal defaults', () => {
    const config = AssistantAutomationsService.Config({
      databasePath: '/tmp/automations.sqlite',
      runsPath: '/tmp/runs',
    })
    expect(config.allowUnbudgetedExecution).toBe(false)
    expect(config.proposalDefaults).toEqual({
      provider: 'deepseek-official', model: 'deepseek-chat', allowedTools: [],
      timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
      misfireKind: 'latest', misfireLimit: 1, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      budgetId: 'assistant-automations-proposals', budgetAmount: 1,
    })
    expect(() => AssistantAutomationsService.Config({
      databasePath: '/tmp/automations.sqlite', runsPath: '/tmp/runs',
      proposalDefaults: { ...proposalDefaults, budgetId: '' },
    })).toThrow(/proposalDefaults|budgetId|pattern|invalid/i)
  })

  test('derives create authority from the authenticated Delivery route and trusted config', async () => {
    const fixture = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = fixture.service.propose(current, {
      idempotencyKey: 'service:trusted-create',
      mutation: {
        op: 'create', automationId: 'auto-review',
        definition: proposedDefinition({
          workspace: '/work/attacker', agentPreset: 'attacker', provider: 'attacker', model: 'attacker',
          timeoutMs: 1, maxOutputTokens: 1, maxToolCalls: 999, principal: 'attacker',
          budgetId: 'attacker', budgetAmount: 1, deliveryBindingId: 'attacker',
        }),
      } as never,
    })
    expect(fixture.prepareAgentApproval).toHaveBeenCalledWith(current, {
      sourceId: 'dsh-enhanced-assistant-automations',
    })
    fixture.service.decideProposal({ proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner',
      expectedVersion: 1, decision: 'approved', reason: 'reviewed' })
    expect(fixture.service.list(current)[0]?.definition).toEqual({
      name: 'Future review', prompt: 'Review safely.', schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
      workspace: '/work/alpha', agentPreset: 'primary', provider: 'trusted-provider', model: 'trusted-model',
      allowedTools: [], timeoutMs: 30_000, maxOutputTokens: 256, maxToolCalls: 1,
      misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      principal: 'lark/main/tenant/owner', budgetId: 'growth-budget', budgetAmount: 1,
      deliveryBindingId: 'binding-owner',
    })
    await fixture.ctx.fiber.restart()
  })

  test('enforces the configured tool subset and exact Delivery/headless route', async () => {
    const routed = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    expect(() => routed.service.propose(current, {
      idempotencyKey: 'service:forged-principal', principal: 'attacker',
      mutation: { op: 'create', automationId: 'forged', definition: proposedDefinition() } as never,
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(() => routed.service.propose(current, {
      idempotencyKey: 'service:extra-tool',
      mutation: { op: 'create', automationId: 'extra-tool', definition: proposedDefinition({
        allowedTools: ['evolution_review', 'shell'],
      }) } as never,
    })).toThrow(/allowed.*tool|tool.*allow/i)
    await routed.ctx.fiber.restart()

    const mismatched = await harness(true, { deliveryRoute: {
      sourceId: 'dsh-enhanced-assistant-automations', bindingId: 'binding-owner',
      workspace: '/work/other', principal: 'lark/main/tenant/owner',
    } })
    expect(() => mismatched.service.propose(current, {
      idempotencyKey: 'service:wrong-workspace',
      mutation: { op: 'create', automationId: 'wrong-workspace', definition: proposedDefinition() } as never,
    })).toThrow(/approval route|workspace/i)
    await mismatched.ctx.fiber.restart()

    const headless = await harness(true, { deliveryRoute: false })
    expect(() => headless.service.propose(current, {
      idempotencyKey: 'service:missing-headless-principal',
      mutation: { op: 'create', automationId: 'missing-principal', definition: proposedDefinition() } as never,
    })).toThrow(/approval route|principal/i)
    const pending = headless.service.propose(current, {
      idempotencyKey: 'service:headless', principal: 'headless:owner',
      mutation: { op: 'create', automationId: 'headless', definition: proposedDefinition() } as never,
    })
    headless.service.decideProposal({ proposalId: pending.proposalId, principal: 'headless:owner',
      expectedVersion: 1, decision: 'approved', reason: 'headless review' })
    expect(headless.service.list(current)[0]?.definition).toMatchObject({
      workspace: '/work/alpha', agentPreset: 'primary', principal: 'headless:owner',
    })
    await headless.ctx.fiber.restart()
  })

  test('registers ctx.assistantAutomations and exposes only approval-gated mutations', async () => {
    const { ctx, service } = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(current, {
      idempotencyKey: 'service:create',
      mutation: { op: 'create', automationId: 'auto-review', definition: proposedDefinition() } as never,
    })
    expect(service.health()).toEqual({ activeAutomations: 0, pausedAutomations: 0,
      pendingTasks: 0, runningTasks: 0, failedRuns: 0, unknownRuns: 0,
      pendingEvaluations: 0, retryingEvaluations: 0, failedEvaluationAttempts: 0,
      deadLetterEvaluations: 0, oldestPendingEvaluationAt: 0, openCircuits: 0,
      openIncidents: 0, pendingIncidentAlerts: 0 })
    expect(service.list(current)).toEqual([])
    const approved = service.decideProposal({
      proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })
    expect(approved).toMatchObject({ status: 'approved', automation: { id: 'auto-review' } })
    expect(service.list(current)).toHaveLength(1)
    expect(service.health()).toMatchObject({ activeAutomations: 1, pausedAutomations: 0 })
    expect((service as unknown as Record<string, unknown>)['createApproved']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('fails closed for denied, absent, relative, or incomplete Agent identity', async () => {
    const denied = await harness(false)
    const input = { idempotencyKey: 'denied',
      mutation: { op: 'create' as const, automationId: 'auto-review', definition: proposedDefinition() } }
    expect(() => denied.service.propose(agent({ cwd: '/work/alpha', preset: 'primary' }), input))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'policy-denied' }))
    expect(() => denied.service.list(undefined))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    const relative = { session: { header: { cwd: 'relative', agentPreset: 'primary' } } } as unknown as Agent
    expect(() => denied.service.list(relative))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    expect(() => denied.service.list(agent({ cwd: '/work/alpha' })))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'missing-identity' }))
    await denied.ctx.fiber.restart()
  })

  test('history is exact-scope, supports exact run lookup, and never falls back to current definitions', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    const complete = (automationId: string, workspace: string, preset: string, output: string, now: number) => {
      store.createApproved({
        automationId, idempotencyKey: `history:create:${automationId}`,
        definition: { ...definition(), workspace, agentPreset: preset },
      })
      const occurrence = store.createManual({ automationId, requestId: `history:${automationId}`, dryRun: false })
      const task = store.listTasks({ automationId, limit: 1 })[0]!
      const duty = store.acquireDuty({ ownerId: 'history-test', now: now - 30, leaseMs: 100_000 })
      store.claimTask({ taskId: task.id, ownerId: 'history-test', fencingToken: duty.fencingToken,
        now: now - 20, leaseMs: 10_000 })
      store.startTask({ taskId: task.id, ownerId: 'history-test', fencingToken: duty.fencingToken,
        now: now - 10, leaseMs: 10_000, sessionId: `session-${automationId}` })
      const run = store.completeTask({ taskId: task.id, ownerId: 'history-test', fencingToken: duty.fencingToken,
        now, outcome: 'succeeded', outputPreview: output, usage: {} })
      return { occurrence, run }
    }
    const alpha = complete('history-alpha', '/work/alpha', 'primary', 'alpha-visible', 10_000)
    const beta = complete('history-beta', '/work/beta', 'secondary', 'beta-secret', 20_000)
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.history(current)).toEqual({
      occurrences: [expect.objectContaining({ id: alpha.occurrence.id })],
      runs: [expect.objectContaining({ id: alpha.run.id, outputPreview: 'alpha-visible' })],
    })
    expect(fixture.service.history(current, { runId: alpha.run.id })).toEqual({
      occurrences: [expect.objectContaining({ id: alpha.occurrence.id })],
      runs: [expect.objectContaining({ id: alpha.run.id })],
    })
    expect(() => fixture.service.history(current, { runId: beta.run.id }))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'not-found' }))
    expect(() => fixture.service.history(current, { runId: 'not-a-run' }))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'invalid-input' }))
    await fixture.ctx.fiber.restart()
  })

  test('authorizes external ingestion explicitly and deduplicates the source event', async () => {
    const { ctx, service } = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(current, { idempotencyKey: 'event-create',
      mutation: { op: 'create', automationId: 'auto-review', definition: proposedDefinition() } as never })
    service.decideProposal({ proposalId: proposal.proposalId, principal: 'lark/main/tenant/owner', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })
    const first = service.ingestExternal({ sourceId: 'event-test', automationId: 'auto-review',
      eventId: 'webhook:1', occurredAt: 123_000 })
    expect(service.ingestExternal({ sourceId: 'event-test', automationId: 'auto-review',
      eventId: 'webhook:1', occurredAt: 123_000 })).toEqual(first)
    await ctx.fiber.restart()
  })

  test('policy-gates system-owned reconciliation and preserves the owner boundary', async () => {
    const allowed = await harness()
    const created = allowed.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', desiredStatus: 'paused', definition: definition(),
    })
    expect(created).toMatchObject({ id: 'heartbeat-primary', owner: 'assistant-heartbeat', status: 'paused' })
    expect(() => allowed.service.reconcileSystem({
      owner: 'other-plugin', automationId: 'heartbeat-primary',
      idempotencyKey: 'takeover', definition: definition(),
    })).toThrow(/owned/i)
    await allowed.ctx.fiber.restart()

    const denied = await harness(false)
    expect(() => denied.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-primary',
      idempotencyKey: 'heartbeat-primary:v1', definition: definition(),
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'policy-denied' }))
    await denied.ctx.fiber.restart()
  })

  test('runs one exact system-owned Host preview without an Agent or production side-channel', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    const dispose = fixture.service.registerHostExecutor({
      descriptor: { executorId: 'assistant-recovery', contractVersion: 2, catalogDigest: 'a'.repeat(64) },
      accepts: spec => spec.runbookId === 'supervised-growth/v2' && spec.runbookVersion === 2,
      async execute(input) {
        expect(input).toMatchObject({
          executionMode: 'preview', targetScope: { workspace: '/work/alpha', preset: 'primary' },
          activationNonce: 'activation-1', ownerRouteId: 'lark/main/tenant/owner',
        })
        return {
          outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          sideEffectState: 'none', retryability: 'safe',
        }
      },
    })
    const created = fixture.service.reconcileSystem({
      owner: 'assistant-recovery', automationId: 'supervised-growth-v2',
      idempotencyKey: 'supervised-growth-v2:activate-preview', definition: systemHostDefinition(),
    })
    const definitionHash = store.getDefinitionHash(created.id)!
    await expect(fixture.service.runSystemDry({
      owner: 'another-owner', automationId: created.id, definitionHash, idempotencyKey: 'preview-wrong-owner',
    })).rejects.toMatchObject({ code: 'not-found' })
    await expect(fixture.service.runSystemDry({
      owner: 'assistant-recovery', automationId: created.id,
      definitionHash: '0'.repeat(64), idempotencyKey: 'preview-old-hash',
    })).rejects.toMatchObject({ code: 'invalid-input' })

    const result = await fixture.service.runSystemDry({
      owner: 'assistant-recovery', automationId: created.id, definitionHash, idempotencyKey: 'preview-1',
    })
    expect(result).toMatchObject({
      occurrence: { dryRun: true, status: 'succeeded' },
      run: { status: 'succeeded', executionMode: 'preview', evidenceStatus: 'suppressed', diagnostic: {
        promptSubmissionState: 'not-applicable', budgetSettlementState: 'not-required',
      } },
    })
    expect(store.listPendingEvidence(100)).toEqual([])
    expect(store.listPendingEvaluations(100)).toEqual([])
    expect(store.listPendingDeliveries(100)).toEqual([])
    expect(store.listIncidents({ automationId: created.id, limit: 100 })).toEqual([])
    expect(store.getCircuit(created.id, definitionHash)).toBeUndefined()
    expect(store.health()).toMatchObject({ openIncidents: 0, openCircuits: 0 })
    // A crash before pause is safe because activation uses a far-future at schedule.
    expect(store.materializeDue({
      now: Date.parse('2026-08-30T00:00:00.000Z'), misfireGraceMs: 60_000, maxCatchUp: 10,
    })).toEqual([])
    expect(store.listOccurrences({ automationId: created.id, limit: 100 }))
      .toEqual([expect.objectContaining({ dryRun: true })])
    fixture.service.reconcileSystem({
      owner: 'assistant-recovery', automationId: created.id,
      idempotencyKey: 'supervised-growth-v2:pause-after-preview', desiredStatus: 'paused',
      definition: systemHostDefinition(),
    })
    expect(store.get(created.id)).toMatchObject({ status: 'paused' })
    dispose()
    await fixture.ctx.fiber.restart()
  })

  test('fails closed when a would-be Growth shadow carries Delivery state', async () => {
    const fixture = await harness()
    const hasEffectBlocker = (fixture.service as unknown as {
      hasShadowEffectBlocker(input: Readonly<Pick<AutomationRun,
        'deliveryRef' | 'deliveryStatus' | 'evidenceStatus' | 'executionMode' | 'usage'>>): boolean
    }).hasShadowEffectBlocker.bind(fixture.service)
    const previewWithoutDelivery: Readonly<Pick<AutomationRun,
      'deliveryRef' | 'deliveryStatus' | 'evidenceStatus' | 'executionMode' | 'usage'>> = Object.freeze({
        executionMode: 'preview', evidenceStatus: 'suppressed', usage: Object.freeze({ toolCalls: 0 }),
      })

    expect(hasEffectBlocker(previewWithoutDelivery)).toBe(true)
    for (const deliveryStatus of ['pending', 'enqueued', 'suppressed'] as const) {
      expect(hasEffectBlocker({ ...previewWithoutDelivery, deliveryStatus })).toBe(false)
    }
    expect(hasEffectBlocker({ ...previewWithoutDelivery, deliveryRef: 'forged-outbox' })).toBe(false)
    expect(hasEffectBlocker({ ...previewWithoutDelivery, evidenceStatus: 'pending' })).toBe(false)
    expect(hasEffectBlocker({ ...previewWithoutDelivery, usage: { toolCalls: 1 } })).toBe(false)
    await fixture.ctx.fiber.restart()
  })

  test('projects exact system-owned health from immutable run scope without returning content', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    fixture.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-health',
      idempotencyKey: 'heartbeat-health:v1',
      definition: { ...definition(), workspace: '/work/old', agentPreset: 'old-preset' },
    })
    const oldHash = store.getDefinitionHash('heartbeat-health')!
    store.createManual({ automationId: 'heartbeat-health', requestId: 'old-run', dryRun: false })
    const duty = store.acquireDuty({ ownerId: 'health-test', now: 1_000, leaseMs: 10_000 })
    const task = store.claimNextTask({ ownerId: 'health-test', fencingToken: duty.fencingToken,
      now: 1_100, leaseMs: 1_000 })!
    store.startTask({ taskId: task.id, ownerId: 'health-test', fencingToken: duty.fencingToken,
      now: 1_101, leaseMs: 1_000, sessionId: 'health-old' })
    fixture.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-health',
      idempotencyKey: 'heartbeat-health:v2',
      definition: { ...definition(), workspace: '/work/new', agentPreset: 'new-preset', prompt: 'new secret prompt' },
    })
    store.completeTask({
      taskId: task.id, ownerId: 'health-test', fencingToken: duty.fencingToken, now: 1_200,
      outcome: 'succeeded', outputPreview: 'secret terminal output', usage: { inputTokens: 999 }, diagnostic: {
        schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
        promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
        budgetSettlementState: 'not-required',
      },
    })
    store.createManual({ automationId: 'heartbeat-health', requestId: 'new-preview', dryRun: true })
    const previewTask = store.claimNextTask({ ownerId: 'health-test', fencingToken: duty.fencingToken,
      now: 1_300, leaseMs: 1_000 })!
    store.startTask({ taskId: previewTask.id, ownerId: 'health-test', fencingToken: duty.fencingToken,
      now: 1_301, leaseMs: 1_000, sessionId: 'health-preview' })
    store.completeTask({
      taskId: previewTask.id, ownerId: 'health-test', fencingToken: duty.fencingToken, now: 1_302,
      outcome: 'succeeded', outputPreview: 'new preview output', usage: {}, diagnostic: {
        schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
        promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe',
        budgetSettlementState: 'not-required',
      },
    })

    const projection = fixture.service.inspectSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-health',
    })
    expect(projection).toMatchObject({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-health', definitionVersion: 2,
      latestTerminalRun: {
        status: 'succeeded', immutableContext: {
          state: 'verified', definitionHash: oldHash, definitionVersion: 1,
          scope: { workspace: '/work/old', agentPreset: 'old-preset' },
        },
      },
      latestTerminalRuns: {
        production: { executionMode: 'production', immutableContext: { scope: {
          workspace: '/work/old', agentPreset: 'old-preset',
        } } },
        preview: { executionMode: 'preview', immutableContext: { scope: {
          workspace: '/work/new', agentPreset: 'new-preset',
        } } },
      },
    })
    expect(projection.definitionHash).not.toBe(oldHash)
    expect(JSON.stringify(projection)).not.toContain('secret terminal output')
    expect(JSON.stringify(projection)).not.toContain('new secret prompt')
    expect(JSON.stringify(projection)).not.toContain('999')
    expect(() => fixture.service.inspectSystemOwned({
      owner: 'another-owner', automationId: 'heartbeat-health',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'not-found' }))
    await fixture.ctx.fiber.restart()
  })

  test('lists a bounded stable content-free inventory for one exact system owner', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    fixture.service.reconcileSystem({
      owner: 'assistant-recovery', automationId: 'recovery-zeta',
      idempotencyKey: 'recovery-zeta:v1',
      definition: { ...definition(), prompt: 'zeta secret', workspace: '/secret/zeta' },
    })
    fixture.service.reconcileSystem({
      owner: 'assistant-recovery', automationId: 'recovery-alpha',
      idempotencyKey: 'recovery-alpha:v1',
      definition: { ...definition(), prompt: 'alpha secret', workspace: '/secret/alpha' },
    })
    fixture.service.reconcileSystem({
      owner: 'another-owner', automationId: 'other-system',
      idempotencyKey: 'other-system:v1', definition: definition(),
    })
    store.createApproved({
      automationId: 'user-owned', idempotencyKey: 'user-owned:v1', definition: definition(),
    })

    const inventory = fixture.service.listSystemOwned({ owner: 'assistant-recovery' })
    expect(Object.isFrozen(inventory)).toBe(true)
    expect(inventory.map(entry => entry.automationId)).toEqual(['recovery-alpha', 'recovery-zeta'])
    expect(inventory.every(entry => Object.isFrozen(entry))).toBe(true)
    expect(inventory[0]).toEqual({
      owner: 'assistant-recovery', automationId: 'recovery-alpha', automationStatus: 'active',
      definitionHash: store.getDefinitionHash('recovery-alpha'), definitionVersion: 1,
    })
    expect(Object.keys(inventory[0]!).sort()).toEqual([
      'automationId', 'automationStatus', 'definitionHash', 'definitionVersion', 'owner',
    ])
    expect(JSON.stringify(inventory)).not.toContain('secret')
    expect(JSON.stringify(inventory)).not.toContain('owner:lark:123')
    expect(fixture.service.listSystemOwned({ owner: 'assistant-recovery', limit: 1 }))
      .toEqual([inventory[0]])
    expect(fixture.service.listSystemOwned({ owner: 'missing-owner' })).toEqual([])
    for (const limit of [0, 1_001, 1.5]) {
      expect(() => fixture.service.listSystemOwned({ owner: 'assistant-recovery', limit }))
        .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'invalid-definition' }))
    }
    await fixture.ctx.fiber.restart()
  })

  test('pauses an exact system-owned revision through a Host-only authorized CAS', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    fixture.service.reconcileSystem({
      owner: 'assistant-recovery',
      automationId: 'recovery-removed-job',
      idempotencyKey: 'recovery-removed-job:v1',
      definition: definition(),
    })
    const definitionHash = store.getDefinitionHash('recovery-removed-job')!
    const input = {
      owner: 'assistant-recovery',
      operationId: 'recovery-config:v2:pause:recovery-removed-job',
      automationId: 'recovery-removed-job',
      definitionHash,
      expectedVersion: 1,
    }

    expect(() => fixture.service.pauseSystemOwned({ ...input, owner: 'another-owner' }))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'not-found' }))
    expect(() => fixture.service.pauseSystemOwned({ ...input, definitionHash: '0'.repeat(64) }))
      .toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'invalid-input' }))
    expect(() => fixture.service.pauseSystemOwned({ ...input, expectedVersion: 2 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'version-conflict' }))

    const receipt = fixture.service.pauseSystemOwned(input)
    expect(receipt).toEqual({
      operationId: input.operationId,
      owner: input.owner,
      automationId: input.automationId,
      definitionHash,
      expectedVersion: 1,
      definitionVersion: 2,
      automationStatus: 'paused',
      replayed: false,
    })
    expect(store.get(input.automationId)).toMatchObject({
      owner: input.owner,
      status: 'paused',
      version: 2,
      definition: definition(),
    })
    expect(fixture.service.pauseSystemOwned(input)).toEqual({ ...receipt, replayed: true })
    expect(() => fixture.service.pauseSystemOwned({ ...input, expectedVersion: 2 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))
    await fixture.ctx.fiber.restart()
  })

  test('arms a Host-only exact circuit probe without clearing it or crossing definition ABA', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    fixture.service.reconcileSystem({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-probe',
      idempotencyKey: 'heartbeat-probe:v1', definition: definition(),
    })
    store.createManual({ automationId: 'heartbeat-probe', requestId: 'open', dryRun: false })
    const duty = store.acquireDuty({ ownerId: 'probe-test', now: 1_000, leaseMs: 10_000 })
    const task = store.claimNextTask({ ownerId: 'probe-test', fencingToken: duty.fencingToken,
      now: 1_100, leaseMs: 1_000 })!
    store.startTask({ taskId: task.id, ownerId: 'probe-test', fencingToken: duty.fencingToken,
      now: 1_101, leaseMs: 1_000, sessionId: 'probe-open' })
    store.completeTask({
      taskId: task.id, ownerId: 'probe-test', fencingToken: duty.fencingToken, now: 1_200,
      outcome: 'failed', outputPreview: 'configuration denied', usage: {}, diagnostic: {
        schemaVersion: 1, failureClass: 'configuration', failurePhase: 'preflight',
        failureCode: 'configuration-denied', promptSubmissionState: 'not-submitted', sideEffectState: 'none',
        retryability: 'after-intervention', budgetSettlementState: 'not-required',
      },
    })
    const definitionHash = store.getDefinitionHash('heartbeat-probe')!
    const open = store.getCircuit('heartbeat-probe', definitionHash)!

    expect(() => fixture.service.probeCircuit({
      owner: 'another-owner',
      operationId: 'probe:cross-owner',
      automationId: 'heartbeat-probe', definitionHash,
      expectedCircuitVersion: open.version,
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'not-found' }))
    store.createApproved({
      automationId: 'user-owned-probe', idempotencyKey: 'user-owned-probe:v1', definition: definition(),
    })
    expect(() => fixture.service.probeCircuit({
      owner: 'assistant-heartbeat',
      operationId: 'probe:user-owned',
      automationId: 'user-owned-probe', definitionHash: store.getDefinitionHash('user-owned-probe')!,
      expectedCircuitVersion: 1,
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'not-found' }))
    expect(() => fixture.service.probeCircuit({
      owner: 'assistant-heartbeat',
      operationId: 'probe:wrong-hash',
      automationId: 'heartbeat-probe', definitionHash: '0'.repeat(64),
      expectedCircuitVersion: open.version,
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'invalid-input' }))
    const probeInput = {
      owner: 'assistant-heartbeat',
      operationId: 'recovery-step:incident-review',
      automationId: 'heartbeat-probe', definitionHash,
      expectedCircuitVersion: open.version, leaseMs: 1_000,
    }
    const receipt = fixture.service.probeCircuit(probeInput)
    expect(receipt).toMatchObject({
      operationId: 'recovery-step:incident-review', replayed: false,
      circuit: { state: 'half-open', version: open.version + 1, probeToken: expect.stringMatching(/^probe-/) },
    })
    expect(fixture.service.probeCircuit(probeInput)).toEqual({ ...receipt, replayed: true })
    expect(() => fixture.service.probeCircuit({ ...probeInput, leaseMs: 2_000 }))
      .toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'idempotency-conflict' }))
    expect(() => fixture.service.probeCircuit({
      ...probeInput, operationId: 'recovery-step:another',
    })).toThrowError(expect.objectContaining<Partial<AutomationStoreError>>({ code: 'version-conflict' }))
    expect(store.getCircuit('heartbeat-probe', definitionHash)).toMatchObject({ state: 'half-open' })
    const projection = fixture.service.inspectSystemOwned({
      owner: 'assistant-heartbeat', automationId: 'heartbeat-probe',
    })
    expect(projection).toMatchObject({
      currentCircuit: { state: 'half-open', definitionHash, failureCode: 'configuration-denied' },
    })
    expect(projection.currentCircuit).not.toHaveProperty('probeToken')
    expect(projection.currentCircuit).not.toHaveProperty('probeTaskId')
    await fixture.ctx.fiber.restart()
  })

  test('atomically schedules the exact Host circuit canary and replays one durable receipt', async () => {
    const fixture = await harness()
    const store = (fixture.service as unknown as { store: AutomationStore }).store
    const automationId = 'recovery-canary'
    fixture.service.reconcileSystem({
      owner: 'assistant-recovery', automationId,
      idempotencyKey: 'recovery-canary:v1', definition: definition(),
    })
    store.createManual({ automationId, requestId: 'open', dryRun: false })
    const duty = store.acquireDuty({ ownerId: 'canary-test', now: 1_000, leaseMs: 10_000 })
    const task = store.claimNextTask({
      ownerId: 'canary-test', fencingToken: duty.fencingToken, now: 1_100, leaseMs: 1_000,
    })!
    store.startTask({
      taskId: task.id, ownerId: 'canary-test', fencingToken: duty.fencingToken,
      now: 1_101, leaseMs: 1_000, sessionId: 'canary-open',
    })
    store.completeTask({
      taskId: task.id, ownerId: 'canary-test', fencingToken: duty.fencingToken, now: 1_200,
      outcome: 'failed', outputPreview: 'configuration denied', usage: {}, diagnostic: {
        schemaVersion: 1, failureClass: 'configuration', failurePhase: 'preflight',
        failureCode: 'configuration-denied', promptSubmissionState: 'not-submitted',
        sideEffectState: 'none', retryability: 'after-intervention', budgetSettlementState: 'not-required',
      },
    })
    const definitionHash = store.getDefinitionHash(automationId)!
    const open = store.getCircuit(automationId, definitionHash)!
    const input = {
      owner: 'assistant-recovery', operationId: 'recovery:incident-review:canary',
      automationId, definitionHash, expectedCircuitVersion: open.version, leaseMs: 60_000,
    }

    expect(() => fixture.service.probeCircuitAndScheduleCanary({
      ...input, owner: 'another-owner',
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'not-found' }))
    expect(() => fixture.service.probeCircuitAndScheduleCanary({
      ...input, definitionHash: '0'.repeat(64),
    })).toThrowError(expect.objectContaining<Partial<AssistantAutomationsError>>({ code: 'invalid-input' }))
    const receipt = fixture.service.probeCircuitAndScheduleCanary(input)
    expect(receipt).toMatchObject({
      operationId: input.operationId, replayed: false, executionMode: 'production',
      circuit: { state: 'half-open', version: open.version + 1 },
    })
    expect(store.getOccurrence(receipt.occurrenceId)).toMatchObject({
      automationId, triggerKind: 'manual', dryRun: false, status: 'pending',
    })
    expect(store.getTaskRecord(receipt.taskId)).toMatchObject({
      automationId, occurrenceId: receipt.occurrenceId, status: 'scheduled',
    })
    const counts = {
      occurrences: store.listOccurrences({ automationId, limit: 20 }).length,
      tasks: store.listTasks({ automationId, limit: 20 }).length,
    }
    expect(fixture.service.probeCircuitAndScheduleCanary(input)).toEqual({ ...receipt, replayed: true })
    expect(store.listOccurrences({ automationId, limit: 20 })).toHaveLength(counts.occurrences)
    expect(store.listTasks({ automationId, limit: 20 })).toHaveLength(counts.tasks)
    await fixture.ctx.fiber.restart()
  })

  test('rejects unsafe configuration and all calls after disposal', async () => {
    for (const config of [
      undefined,
      { databasePath: 'relative.sqlite', runsPath: '/tmp/runs' },
      { databasePath: '/tmp/automations.sqlite', runsPath: 'relative' },
      { databasePath: '/tmp/automations.sqlite', runsPath: '/tmp/runs', maxConcurrency: 0 },
    ]) {
      const ctx = new Context()
      expect(() => new AssistantAutomationsService(ctx, config as never)).toThrow(/assistant-automations|absolute|concurrency/i)
      await ctx.fiber.restart()
    }
    const fixture = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    await fixture.ctx.fiber.restart()
    expect(() => fixture.service.list(current)).toThrowError(expect.objectContaining({ code: 'disposed' }))
  })
})
