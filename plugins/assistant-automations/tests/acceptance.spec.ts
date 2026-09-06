import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService } from '@dsh-enhanced/assistant-verifier'
import { createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptanceContract, TaskAcceptanceRegistration } from '../src/acceptance.ts'
import { AutomationArtifactStore } from '../src/artifacts.ts'
import { AutomationCoordinator, type AutomationRunner } from '../src/coordinator.ts'
import { AssistantAutomationsService } from '../src/service.ts'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const at = Date.parse('2026-08-21T10:01:00.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Acceptance run', prompt: 'Write the accepted result.',
    schedule: { kind: 'at' as const, at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' as const }, overlap: 'skip' as const,
    retrySafety: 'idempotent' as const, maxRetries: 2, principal: 'owner:lark:123',
    ...overrides,
  }
}

function contract(taskId: string, overrides: Partial<AcceptanceContract> = {}): AcceptanceContract {
  return {
    id: 'acceptance-contract', digest: 'a'.repeat(64),
    scope: { workspace: '/work/alpha', preset: 'primary' },
    owner: { principalRecordId: 'principal-owner', principalVersion: 4 },
    task: { kind: 'automation-run', ref: `run-${taskId}` },
    ...overrides,
  }
}

function bind(store: AutomationStore, taskId: string, overrides: Partial<{
  scope: { workspace: string; preset: string }
  owner: { principalRecordId: string; principalVersion: number }
  contractId: string
  contractDigest: string
}> = {}) {
  store.bindTaskAcceptance({
    taskId, contractId: overrides.contractId ?? 'acceptance-contract', contractDigest: overrides.contractDigest ?? 'a'.repeat(64),
    scope: overrides.scope ?? { workspace: '/work/alpha', preset: 'primary' },
    owner: overrides.owner ?? { principalRecordId: 'principal-owner', principalVersion: 4 },
    bindingId: 'binding-owner', bindingVersion: 3, bindingGeneration: 2, dispatchedAt: 1_200,
  })
}

function start(store: AutomationStore, automationId: string) {
  store.createApproved({ automationId, idempotencyKey: `create:${automationId}`, definition: definition() })
  store.materializeDue({ now: at, misfireGraceMs: 60_000, maxCatchUp: 1 })
  const task = store.listTasks({ automationId, limit: 1 })[0]!
  const duty = store.acquireDuty({ ownerId: 'acceptance-owner', now: 1_000, leaseMs: 10_000 })
  store.claimTask({ taskId: task.id, ownerId: 'acceptance-owner', fencingToken: duty.fencingToken, now: 1_100, leaseMs: 100 })
  store.startTask({ taskId: task.id, ownerId: 'acceptance-owner', fencingToken: duty.fencingToken, now: 1_150, leaseMs: 100, sessionId: 'acceptance-session' })
  return { task, duty }
}

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-acceptance-'))
  roots.push(root)
  const path = join(root, 'automations.sqlite')
  return { root, path, store: new AutomationStore({ path, now: () => 1_300 }) }
}

describe('automation acceptance persistence', () => {
  test('proves only the exact persisted scope, owner, and digest, and rejects a duplicate bind', async () => {
    const fixture = await storeFixture()
    const { task, duty } = start(fixture.store, 'acceptance-exact')
    bind(fixture.store, task.id)
    expect(() => bind(fixture.store, task.id)).toThrow(/submitted again/i)

    fixture.store.completeTask({
      taskId: task.id, ownerId: 'acceptance-owner', fencingToken: duty.fencingToken,
      now: 1_200, outcome: 'succeeded', outputPreview: 'done', usage: {},
    })
    fixture.store.markAcceptedTaskQuiescent(task.id, true)

    expect(fixture.store.inspectAcceptedExecution(contract(task.id))).toMatchObject({
      status: 'succeeded', quiescent: true, executionRef: `run-${task.id}`,
    })
    expect(fixture.store.inspectAcceptedExecution(contract(task.id, {
      scope: { workspace: '/work/other', preset: 'primary' },
    }))).toBeNull()
    expect(fixture.store.inspectAcceptedExecution(contract(task.id, {
      owner: { principalRecordId: 'other-owner', principalVersion: 4 },
    }))).toBeNull()
    expect(fixture.store.inspectAcceptedExecution(contract(task.id, { digest: 'b'.repeat(64) }))).toBeNull()
    fixture.store.close()
  })

  test('restarts an accepted submitted attempt as durable unknown without replaying the original execution', async () => {
    const fixture = await storeFixture()
    const { task } = start(fixture.store, 'acceptance-restart')
    bind(fixture.store, task.id)
    fixture.store.close()

    const reopened = new AutomationStore({ path: fixture.path, now: () => 1_300 })
    expect(reopened.recoverExpiredTasks({ now: 1_300 })).toEqual([
      expect.objectContaining({ id: task.id, status: 'unknown', attemptCount: 1 }),
    ])
    expect(reopened.listRuns({ automationId: 'acceptance-restart', limit: 1 }))
      .toEqual([expect.objectContaining({ id: `run-${task.id}`, status: 'unknown' })])
    reopened.close()
  })

  test.each(['cancelled', 'unknown'] as const)('never marks a %s accepted run quiescent', async outcome => {
    const fixture = await storeFixture()
    fixture.store.close()
    let now = at
    const store = new AutomationStore({ path: join(fixture.root, `${outcome}.sqlite`), now: () => now })
    const runner: AutomationRunner = {
      async run(input) {
        bind(store, input.task.id)
        return { outcome, output: outcome, usage: {}, quiescent: true }
      },
    }
    const coordinator = new AutomationCoordinator({
      store, artifacts: new AutomationArtifactStore({ rootPath: join(fixture.root, `${outcome}-runs`), maxBytes: 8_192 }),
      runner, ownerId: `${outcome}-owner`, now: () => now, dutyLeaseMs: 10_000, taskLeaseMs: 1_000,
      misfireGraceMs: 60_000, maxCatchUp: 1, maxConcurrency: 1,
    })
    store.createApproved({ automationId: `acceptance-${outcome}`, idempotencyKey: `create:${outcome}`, definition: definition() })
    await coordinator.tick()
    await coordinator.whenIdle()
    const task = store.listTasks({ automationId: `acceptance-${outcome}`, limit: 1 })[0]!
    const proof = store.inspectAcceptedExecution(contract(task.id))
    expect(proof).toMatchObject({ status: outcome, quiescent: false })
    await coordinator.stop()
    store.close()
    now += 1
  })
})

test('store-terminal Automations, Verifier, and Evaluation integration persists and verifies one accepted execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-acceptance-services-'))
  roots.push(root)
  await writeFile(join(root, 'result.txt'), 'verified')
  const ctx = new Context()
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'), budgets: [], rules: [],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
    allowUnbudgetedExecution: true,
  })
  const authority = {
    kind: 'runner' as const, id: 'read-result', executable: process.execPath,
    fixedArgs: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))"],
    timeoutMs: 1_000, maxOutputBytes: 1_024,
  }
  const authorities = createVerifierAuthorities({ authorities: [authority] })
  const profile = {
    id: 'automation-result', version: 1,
    scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'principal-owner', principalVersion: 4 },
    taskKind: 'automation-run' as const, objective: 'Write the accepted result.', validityMs: 60_000,
    bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
    criteria: [{ id: 'result', kind: 'process-behavior' as const, authority: { id: authority.id, digest: authorities[0]!.digest },
      artifactPath: 'result.txt', stdin: '', expectedStdout: 'verified', expectedExitCode: 0 }],
  }
  const verifier = new AssistantVerifierService(ctx, {
    databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true,
    authorities: [authority], profiles: [profile],
  })
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  await new Promise<void>(resolve => setImmediate(resolve))

  const service = ctx.assistantAutomations
  const store = (service as unknown as { store: AutomationStore }).store
  const coordinator = (service as unknown as { coordinator: AutomationCoordinator }).coordinator
  const ownerId = (coordinator as unknown as { ownerId: string }).ownerId
  store.createApproved({ automationId: 'acceptance-service', idempotencyKey: 'create:service', definition: definition({ workspace: root }) })
  store.materializeDue({ now: at, misfireGraceMs: 60_000, maxCatchUp: 1 })
  const task = store.listTasks({ automationId: 'acceptance-service', limit: 1 })[0]!
  const duty = store.acquireDuty({ ownerId, now: Date.now(), leaseMs: 10_000 })
  store.claimTask({ taskId: task.id, ownerId, fencingToken: duty.fencingToken, now: Date.now(), leaseMs: 10_000 })
  store.startTask({ taskId: task.id, ownerId, fencingToken: duty.fencingToken, now: Date.now(), leaseMs: 10_000, sessionId: 'service-session' })
  ;(service as unknown as { prepareTaskAcceptance(input: unknown): void }).prepareTaskAcceptance({
    taskId: task.id, automationId: 'acceptance-service', scope: { workspace: root, preset: 'primary' },
    objective: 'Write the accepted result.', owner: { principalRecordId: 'principal-owner', principalVersion: 4 },
    binding: { id: 'binding-owner', version: 3, generation: 2 },
  })
  store.completeTask({ taskId: task.id, ownerId, fencingToken: duty.fencingToken,
    now: Date.now(), outcome: 'succeeded', outputPreview: 'verified', usage: {} })
  store.markAcceptedTaskQuiescent(task.id, true)

  await coordinator.tick()
  await new Promise<void>(resolve => setImmediate(resolve))
  await verifier.tick()
  expect(verifier.health()).toMatchObject({ hostProducers: expect.arrayContaining(['assistantAutomations']), evaluationConnected: true })
  expect(verifier.continuations()).toEqual([])
  expect(evaluation.query({ scope: { workspace: root, preset: 'primary' }, situation: 'automation:acceptance-service', limit: 10 }))
    .toEqual(expect.arrayContaining([expect.objectContaining({
      trust: 'trusted', objectiveStatus: 'achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
    })]))
  await ctx.fiber.restart()
})

test('keeps required acceptance fail-closed when the verifier detaches, then accepts a replacement registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-acceptance-detach-'))
  roots.push(root)
  const ctx = new Context()
  let registration: TaskAcceptanceRegistration | undefined
  ctx.provide('assistantVerifier' as never, {
    ownsTaskAcceptanceRegistration: (value: unknown) => value === registration,
  } as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'), budgets: [], rules: [],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
    allowUnbudgetedExecution: true,
  })
  const service = ctx.assistantAutomations
  registration = {
    protocol: 'assistant-verifier/host-producer/v1' as const,
    generation: service.trustedAcceptanceProducerGeneration(),
    owner: { ownsTaskAcceptanceRegistration: value => value === registration }, requiresAcceptance: true,
    prepare: () => null, completed: async () => {},
  }
  const detach = service.registerTaskAcceptanceSink(registration as never)
  detach()
  expect(() => (service as unknown as { prepareTaskAcceptance(input: unknown): void }).prepareTaskAcceptance({
    taskId: 'task-detached', automationId: 'detached', scope: { workspace: root, preset: 'primary' }, objective: 'x',
    owner: { principalRecordId: 'principal-owner', principalVersion: 4 }, binding: { id: 'binding', version: 1, generation: 1 },
  })).toThrow(/required task acceptance verifier is unavailable/i)
  const restoredDetach = service.registerTaskAcceptanceSink(registration as never)
  expect((service as unknown as { acceptanceSink: unknown }).acceptanceSink).toBeDefined()
  const optional: TaskAcceptanceRegistration = { ...registration, requiresAcceptance: false }
  restoredDetach()
  registration = optional
  const optionalDetach = service.registerTaskAcceptanceSink(optional as never)
  expect(() => (service as unknown as { prepareTaskAcceptance(input: unknown): void }).prepareTaskAcceptance({
    taskId: 'task-optional', automationId: 'optional', scope: { workspace: root, preset: 'primary' }, objective: 'x',
  })).toThrow(/required task acceptance lacks an authenticated Delivery owner/i)
  optionalDetach()
  await ctx.fiber.restart()
})
