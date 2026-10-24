import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationArtifactStore } from '../src/artifacts.ts'
import { AutomationCoordinator, type AutomationRunner } from '../src/coordinator.ts'
import { AssistantAutomationsService } from '../src/service.ts'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const at = Date.parse('2026-08-21T10:01:00.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(runAt = at): object {
  return {
    name: 'Maintenance fence task', prompt: 'Run once.',
    schedule: { kind: 'at', at: new Date(runAt).toISOString() },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123',
  }
}

async function coordinatorFixture(runner: AutomationRunner, paused: () => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-maintenance-'))
  roots.push(root)
  const store = new AutomationStore({ path: join(root, 'automations.sqlite'), now: () => at })
  const artifacts = new AutomationArtifactStore({ rootPath: join(root, 'runs'), maxBytes: 64_000 })
  const coordinator = new AutomationCoordinator({
    store, artifacts, runner, ownerId: 'maintenance-test', now: () => at,
    dutyLeaseMs: 10_000, taskLeaseMs: 5_000, misfireGraceMs: 60_000, maxCatchUp: 10,
    maxConcurrency: 2, dispatchPaused: paused,
  })
  store.createApproved({ automationId: 'maintenance-task', idempotencyKey: 'create:maintenance', definition: definition() })
  store.materializeDue({ now: at, misfireGraceMs: 60_000, maxCatchUp: 10, hostAvailability: [] })
  const tasks = store.listTasks({ limit: 10 })
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.status).toBe('scheduled')
  return { root, store, coordinator, task: tasks[0]! }
}

describe('planned restart maintenance fence for automations', () => {
  test('preserves scheduled work while paused and executes the same task once after release', async () => {
    let paused = true
    const calls: string[] = []
    const fixture = await coordinatorFixture({ async run(input) {
      calls.push(input.task.id)
      return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {}, quiescent: true }
    } }, () => paused)
    try {
      const before = fixture.store.getTaskRecord(fixture.task.id)
      for (let index = 0; index < 3; index += 1) await fixture.coordinator.tick()
      expect(fixture.store.getTaskRecord(fixture.task.id)).toEqual(before)
      expect(calls).toEqual([])
      expect(fixture.coordinator.isRunnerQuiescent()).toBe(true)
      expect(fixture.store.countInFlightTasks()).toBe(0)
      paused = false
      await fixture.coordinator.tick()
      await fixture.coordinator.whenIdle()
      await fixture.coordinator.tick()
      expect(calls).toEqual([fixture.task.id])
      expect(fixture.store.getTaskRecord(fixture.task.id)?.status).toBe('succeeded')
      expect(fixture.store.countInFlightTasks()).toBe(0)
    } finally { await fixture.coordinator.stop(); fixture.store.close() }
  })

  test('active and globally claimed tasks fail the restart quiescence proof', async () => {
    let finish: (() => void) | undefined
    const released = new Promise<void>(resolve => { finish = resolve })
    const fixture = await coordinatorFixture({ async run(input) {
      await released
      return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {}, quiescent: true }
    } }, () => false)
    const secondView = new AutomationStore({ path: join(fixture.root, 'automations.sqlite'), now: () => at })
    const ctx = new Context()
    try {
      await ctx.plugin(AssistantPolicyService, { databasePath: join(fixture.root, 'policy.sqlite'), rules: [] })
      await ctx.plugin(AssistantAutomationsService, { databasePath: join(fixture.root, 'automations.sqlite'),
        runsPath: join(fixture.root, 'service-runs'), schedulerEnabled: false, allowUnbudgetedExecution: true })
      await fixture.coordinator.tick()
      expect(fixture.coordinator.isRunnerQuiescent()).toBe(false)
      expect(fixture.store.countInFlightTasks()).toBe(1)
      expect(secondView.countInFlightTasks()).toBe(1)
      expect(ctx.assistantAutomations.isRestartQuiescent()).toBe(false)
      finish?.()
      await fixture.coordinator.whenIdle()
      expect(fixture.coordinator.isRunnerQuiescent()).toBe(true)
      expect(secondView.countInFlightTasks()).toBe(0)
      expect(ctx.assistantAutomations.isRestartQuiescent()).toBe(true)
    } finally { finish?.(); await fixture.coordinator.stop(); secondView.close(); fixture.store.close(); await ctx.fiber.restart() }
  })

  test('Cordis service observes an optional Delivery maintenance fence before claiming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-maintenance-'))
    roots.push(root)
    let draining = true
    const ctx = new Context()
    ctx.provide('assistantDelivery' as never, {
      isMaintenanceDraining: () => draining,
      prepareAgentApproval: () => { throw new Error('unexpected approval') },
      prepareWorkflowApproval: () => { throw new Error('unexpected approval') },
    } as never)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
    await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'), schedulerEnabled: false, allowUnbudgetedExecution: true })
    const external = new AutomationStore({ path: join(root, 'automations.sqlite') })
    try {
      const now = Date.now()
      external.createApproved({ automationId: 'service-maintenance', idempotencyKey: 'create:service-maintenance',
        definition: definition(now - 1_000) })
      external.materializeDue({ now, misfireGraceMs: 60_000, maxCatchUp: 10, hostAvailability: [] })
      const before = external.listTasks({ limit: 10 })[0]!
      expect(before.status).toBe('scheduled')
      await ctx.assistantAutomations.tick()
      expect(external.getTaskRecord(before.id)).toEqual(before)
      expect(ctx.assistantAutomations.isRestartQuiescent()).toBe(true)
      draining = false
      await ctx.assistantAutomations.tick()
      await ctx.assistantAutomations.whenIdle()
      expect(external.getTaskRecord(before.id)?.status).not.toBe('scheduled')
    } finally { external.close(); await ctx.fiber.restart() }
  })
})
