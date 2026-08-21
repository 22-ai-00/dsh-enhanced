import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantHeartbeatError,
  AssistantHeartbeatService,
  type HeartbeatConfig,
} from '../src/service.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakePolicy extends Service {
  allow = true
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorizeAgent() { return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' } }
}

class FakeAutomations extends Service {
  readonly calls: Array<Record<string, unknown>> = []
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  reconcileSystem(input: Record<string, unknown>) {
    this.calls.push(input)
    return { id: input['automationId'], owner: input['owner'], status: input['desiredStatus'], version: this.calls.length }
  }
}

function agent(workspace = '/work/alpha', preset = 'primary'): Agent {
  return { session: { header: { cwd: workspace, agentPreset: preset } } } as unknown as Agent
}

async function harness(initialScratch = 'Review open commitments.') {
  const root = await mkdtemp(join(tmpdir(), 'assistant-heartbeat-service-'))
  roots.push(root)
  const ctx = new Context()
  const policy = new FakePolicy(ctx)
  const automations = new FakeAutomations(ctx)
  const config: HeartbeatConfig = {
    id: 'primary', enabled: true, scratchPath: join(root, 'primary.md'), initialScratch,
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'model',
    timezone: 'Asia/Shanghai', activeStartHour: 8, activeEndHour: 22, intervalMinutes: 30,
    principal: 'owner:me', allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512,
    maxToolCalls: 0, budgetId: 'heartbeat-daily', budgetAmount: 512,
  }
  const service = new AssistantHeartbeatService(ctx, { heartbeats: [config], maxScratchBytes: 2_048 })
  return { root, ctx, policy, automations, service }
}

describe('assistant heartbeat service', () => {
  test('reconciles non-empty scratch active and empty scratch paused with stable ownership', async () => {
    const fixture = await harness()
    expect(fixture.automations.calls[0]).toMatchObject({
      owner: 'assistant-heartbeat', automationId: 'heartbeat:primary', desiredStatus: 'active',
    })
    expect(fixture.service.health()).toEqual({ active: 1, paused: 0, empty: 0 })
    const before = fixture.service.status(agent(), 'primary')
    const empty = fixture.service.updateScratch(agent(), {
      heartbeatId: 'primary', expectedRevision: before.revision, content: '   ',
    })
    expect(empty).toMatchObject({ empty: true, status: 'paused' })
    expect(fixture.service.health()).toEqual({ active: 0, paused: 1, empty: 1 })
    expect(fixture.automations.calls.at(-1)).toMatchObject({
      owner: 'assistant-heartbeat', automationId: 'heartbeat:primary', desiredStatus: 'paused',
    })
    expect(JSON.stringify(fixture.service.status(agent(), 'primary'))).not.toContain('Review open commitments')
    await fixture.ctx.fiber.restart()
  })

  test('uses revision CAS and exact agent identity before policy authorization', async () => {
    const fixture = await harness()
    const current = fixture.service.status(agent(), 'primary')
    expect(() => fixture.service.updateScratch(agent('/work/other'), {
      heartbeatId: 'primary', expectedRevision: current.revision, content: 'changed',
    })).toThrowError(expect.objectContaining<Partial<AssistantHeartbeatError>>({ code: 'identity-mismatch' }))
    fixture.policy.allow = false
    expect(() => fixture.service.updateScratch(agent(), {
      heartbeatId: 'primary', expectedRevision: current.revision, content: 'changed',
    })).toThrowError(expect.objectContaining<Partial<AssistantHeartbeatError>>({ code: 'policy-denied' }))
    fixture.policy.allow = true
    fixture.service.updateScratch(agent(), {
      heartbeatId: 'primary', expectedRevision: current.revision, content: 'changed',
    })
    expect(() => fixture.service.updateScratch(agent(), {
      heartbeatId: 'primary', expectedRevision: current.revision, content: 'stale',
    })).toThrow(/revision/i)
    await fixture.ctx.fiber.restart()
  })

  test('reuses the exact revision key after restart and rejects calls after disposal', async () => {
    const fixture = await harness()
    const firstKey = fixture.automations.calls[0]?.['idempotencyKey']
    const first = fixture.service
    await fixture.ctx.fiber.restart()
    expect(() => first.status(agent(), 'primary'))
      .toThrowError(expect.objectContaining<Partial<AssistantHeartbeatError>>({ code: 'disposed' }))

    const secondContext = new Context()
    new FakePolicy(secondContext)
    const secondAutomations = new FakeAutomations(secondContext)
    const second = new AssistantHeartbeatService(secondContext, {
      heartbeats: [{
        id: 'primary', enabled: true, scratchPath: join(fixture.root, 'primary.md'), initialScratch: 'ignored',
        workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'model',
        timezone: 'Asia/Shanghai', activeStartHour: 8, activeEndHour: 22, intervalMinutes: 30,
        principal: 'owner:me', allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512,
        maxToolCalls: 0, budgetId: 'heartbeat-daily', budgetAmount: 512,
      }],
    })
    expect(secondAutomations.calls[0]?.['idempotencyKey']).toBe(firstKey)
    await secondContext.fiber.restart()
    expect(() => second.status(agent(), 'primary'))
      .toThrowError(expect.objectContaining<Partial<AssistantHeartbeatError>>({ code: 'disposed' }))
  })
})
