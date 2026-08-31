import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, test } from 'vitest'
import { ASSISTANT_EVALUATION_SKILL, AssistantEvaluationService } from '../src/service.ts'
import { installTrustedTestProducers } from './trusted-producer-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart())) })

function agent(workspace = '/work/alpha'): Agent {
  const id = SessionId(`evaluation-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: workspace, agentPreset: 'primary',
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

function call(name: string, args: Record<string, unknown>, target?: Agent) {
  return {
    callId: CallId(`evaluation-call-${Math.random()}`), name, arguments: args,
    signal: new AbortController().signal, ...(target === undefined ? {} : { agent: target }),
  }
}

async function harness() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolRuntime)
  const producers = installTrustedTestProducers(ctx)
  const fiber = await ctx.plugin(AssistantEvaluationService, { databasePath: ':memory:', maxReviewOutcomes: 5 })
  return { ctx, service: ctx.assistantEvaluation, fiber, ...producers }
}

describe('evaluation review tool', () => {
  test('registers review plus a constrained self-reported assessment tool and disposes both', async () => {
    const { ctx, fiber } = await harness()
    expect(ctx.tools.schemas().map(item => item.name).filter(name => name.startsWith('evaluation_')))
      .toEqual(['evaluation_review', 'evaluation_self_assess'])
    await fiber.dispose()
    expect(ctx.tools.schemas().map(item => item.name).filter(name => name.startsWith('evaluation_'))).toEqual([])
  })

  test('ships a bounded self-evaluation workflow that keeps self-reports below trusted evidence', async () => {
    const { ctx } = await harness()
    const skill = await ctx.skills.get('personal-assistant-self-evaluation')
    expect(skill).toMatchObject({ content: ASSISTANT_EVALUATION_SKILL })
    for (const tool of ['evaluation_review', 'automation_history', 'memory_search_confirmed', 'evaluation_self_assess']) {
      expect(ASSISTANT_EVALUATION_SKILL).toContain(tool)
    }
    expect(ASSISTANT_EVALUATION_SKILL).toContain('self-reported')
    expect(ASSISTANT_EVALUATION_SKILL).toContain('untrusted')
    expect(ASSISTANT_EVALUATION_SKILL.length).toBeLessThan(3_000)
  })

  test('fails closed without an Agent and only reviews the caller exact scope', async () => {
    const { automations, ctx } = await harness()
    for (const [workspace, key] of [['/work/alpha', 'alpha'], ['/work/beta', 'beta']] as const) {
      automations.append({
        scope: { workspace, preset: 'primary' },
        automationId: `weekly-report-${key}`, situation: `automation:weekly-report-${key}`,
        runId: `run-scope-${key}`, executionMode: 'production',
        executionStatus: 'succeeded', objectiveStatus: workspace.endsWith('alpha') ? 'achieved' : 'not-achieved',
        deliveryStatus: 'not-required', metrics: {}, occurredAt: Date.now(),
        idempotencyKey: key, evaluatorVersion: 'terminal-v1',
      })
    }
    const missing = await ctx.tools.execute(call('evaluation_review', {}))
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('missing-agent')

    const result = await ctx.tools.execute(call('evaluation_review', { lookback_days: 30, limit: 5 }, agent()))
    expect(result.isError).toBe(false)
    const value = result.isError ? undefined : result.value as { summary: { total: number }, outcomes: unknown[] }
    expect(value?.summary.total).toBe(1)
    expect(value?.outcomes).toHaveLength(1)
    const rendered = JSON.stringify(result.content)
    expect(rendered).not.toContain('/work/beta')
    expect(rendered).not.toContain('private-beta')
    expect(rendered).toContain('untrusted data')
  })

  test('derives scope and immutable trust fields while linking one self-assessment to its parent', async () => {
    const { automations, ctx, service } = await harness()
    const target = agent()
    const runId = `run-task-occ-${'a'.repeat(64)}`
    const outcome = automations.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'daily-review', situation: 'automation:daily-review', runId,
      executionMode: 'production',
      executionStatus: 'succeeded', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      metrics: {}, occurredAt: Date.now(), idempotencyKey: 'daily-review', evaluatorVersion: 'terminal-v1',
    })

    const before = await ctx.tools.execute(call('evaluation_review', { limit: 5 }, target))
    expect(before.isError).toBe(false)
    expect(before.isError ? undefined : before.value).toMatchObject({
      outcomes: [expect.objectContaining({ outcomeId: outcome.id, automationRunId: runId })],
      selfAssessments: [],
    })

    const assessed = await ctx.tools.execute(call('evaluation_self_assess', {
      outcome_id: outcome.id,
      objective_status: 'achieved',
      memory_ids: ['memory-owner-format'],
    }, target))
    expect(assessed.isError).toBe(false)
    expect(assessed.isError ? undefined : assessed.value).toMatchObject({
      outcomeId: outcome.id, objectiveStatus: 'achieved', trust: 'self-reported',
    })
    expect(service.health()).toMatchObject({ outcomes: 1, trustedOutcomes: 1, selfAssessments: 1 })
    expect(service.review(target).selfAssessments).toEqual([
      expect.objectContaining({
        outcomeId: outcome.id, objectiveStatus: 'achieved', trust: 'self-reported',
        evidence: [{ kind: 'memory-reference', ref: 'memory-owner-format' }],
        evaluator: { id: 'memory-assisted-self-review', version: '1' },
      }),
    ])

    const wrongScope = await ctx.tools.execute(call('evaluation_self_assess', {
      outcome_id: outcome.id, objective_status: 'achieved',
    }, agent('/work/beta')))
    expect(wrongScope.isError).toBe(true)
    expect(JSON.stringify(wrongScope.content)).toContain('current Agent scope')
  })

  test('reviews a terminal plus exact owner reply as one completed task and no longer offers it for self-assessment', async () => {
    const { automations, ctx, delivery, service } = await harness()
    const target = agent()
    const runId = `run-task-occ-${'d'.repeat(64)}`
    const terminal = automations.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'owner-reviewed', situation: 'automation:owner-reviewed', runId,
      executionMode: 'production',
      executionStatus: 'succeeded', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      metrics: { outputTokens: 12 },
      occurredAt: Date.now(), idempotencyKey: 'owner-reviewed-terminal',
      evaluatorVersion: 'terminal-v1',
    })
    delivery.append({
      scope: terminal.scope, situation: terminal.situation,
      runId, outboxId: 'owner-reviewed-outbox', chatId: 'chat-owner-reviewed',
      principalId: 'owner:lark:123', bindingId: 'binding-owner-reviewed',
      objectiveStatus: 'achieved', occurredAt: terminal.occurredAt,
      idempotencyKey: 'owner-reviewed-feedback',
    })

    const review = service.review(target)
    expect(review.summary).toMatchObject({
      total: 1,
      execution: { succeeded: 1 },
      objective: { achieved: 1, unknown: 0 },
      delivery: { delivered: 1 },
      metrics: { outputTokens: 12 },
    })
    expect(review.outcomes).toHaveLength(1)
    expect(review.outcomes[0]).toMatchObject({
      id: terminal.id,
      objectiveStatus: 'achieved',
      deliveryStatus: 'delivered',
    })
    expect(review.outcomes[0]?.projection).toMatchObject({
      status: 'ready', subjectKind: 'automation-run',
    })
    const rendered = await ctx.tools.execute(call('evaluation_review', { limit: 5 }, target))
    expect(rendered.isError).toBe(false)
    expect(rendered.isError ? undefined : rendered.value).toMatchObject({
      summary: { total: 1 },
      outcomes: [expect.objectContaining({
        outcomeId: terminal.id,
        objectiveStatus: 'achieved',
        projectionStatus: 'ready',
        automationRunId: runId,
      })],
    })
    const selfAssessment = await ctx.tools.execute(call('evaluation_self_assess', {
      outcome_id: terminal.id, objective_status: 'partial',
    }, target))
    expect(selfAssessment.isError).toBe(true)
    expect(JSON.stringify(selfAssessment.content)).toContain('unknown objective')
  })

  test('only exposes first-party trusted Automations run references', async () => {
    const { automations, ctx, service } = await harness()
    const target = agent()
    const validRun = `run-task-occ-${'b'.repeat(64)}`
    const base = {
      scope: { workspace: '/work/alpha', preset: 'primary' }, situation: 'automation:review',
      executionStatus: 'succeeded' as const, objectiveStatus: 'unknown' as const,
      deliveryStatus: 'not-required' as const, metrics: {}, occurredAt: Date.now(),
    }
    service.append({
      ...base, source: { kind: 'import', id: 'third-party' }, trust: 'external',
      evidence: [{ kind: 'automation-run', ref: 'opaque-secret-ref' }],
      idempotencyKey: 'forged-source', evaluator: { id: 'third-party', version: '1' },
    })
    service.append({
      ...base, source: { kind: 'automation', id: 'assistant-automations' }, trust: 'self-reported',
      evidence: [{ kind: 'automation-run', ref: validRun }],
      idempotencyKey: 'forged-evaluator', evaluator: { id: 'other-evaluator', version: 'terminal-v1' },
    })
    automations.append({
      scope: base.scope, automationId: 'review', situation: base.situation,
      runId: 'run-not-a-real-id', executionMode: 'production', executionStatus: 'succeeded',
      objectiveStatus: 'unknown', deliveryStatus: 'not-required', metrics: {},
      occurredAt: base.occurredAt, idempotencyKey: 'malformed-run', evaluatorVersion: 'terminal-v1',
    })
    automations.append({
      scope: base.scope, automationId: 'review', situation: base.situation,
      runId: validRun, executionMode: 'production', executionStatus: 'succeeded',
      objectiveStatus: 'unknown', deliveryStatus: 'not-required', metrics: {},
      occurredAt: base.occurredAt, idempotencyKey: 'first-party', evaluatorVersion: 'terminal-v1',
    })

    const result = await ctx.tools.execute(call('evaluation_review', { limit: 5 }, target))
    expect(result.isError).toBe(false)
    const outcomes = result.isError ? [] : (result.value as { outcomes: Array<Record<string, unknown>> }).outcomes
    expect(outcomes.filter(value => value.automationRunId !== undefined)).toEqual([
      expect.objectContaining({ automationRunId: validRun }),
    ])
    expect(JSON.stringify(result.content)).not.toContain('opaque-secret-ref')
  })

  test('does not feed heartbeat maintenance outcomes back into the next automatic review', async () => {
    const { automations, service } = await harness()
    const target = agent()
    const base = {
      scope: { workspace: '/work/alpha', preset: 'primary' }, executionStatus: 'succeeded' as const,
      objectiveStatus: 'unknown' as const, deliveryStatus: 'not-required' as const,
      source: { kind: 'automation' as const, id: 'assistant-automations' }, trust: 'trusted' as const,
      evidence: [], metrics: {}, occurredAt: Date.now(),
      evaluator: { id: 'assistant-automations', version: 'terminal-v1' },
    }
    automations.append({
      scope: base.scope, automationId: 'heartbeat:supervised-growth',
      situation: 'automation:heartbeat:supervised-growth', runId: 'run-heartbeat',
      executionMode: 'production', executionStatus: base.executionStatus,
      objectiveStatus: base.objectiveStatus, deliveryStatus: base.deliveryStatus, metrics: {},
      occurredAt: base.occurredAt, idempotencyKey: 'heartbeat', evaluatorVersion: 'terminal-v1',
    })
    automations.append({
      scope: base.scope, automationId: 'user-report', situation: 'automation:user-report',
      runId: 'run-user-report', executionMode: 'production', executionStatus: base.executionStatus,
      objectiveStatus: base.objectiveStatus, deliveryStatus: base.deliveryStatus, metrics: {},
      occurredAt: base.occurredAt, idempotencyKey: 'user-report', evaluatorVersion: 'terminal-v1',
    })

    expect(service.review(target)).toMatchObject({
      summary: { total: 1 },
      outcomes: [expect.objectContaining({ situation: 'automation:user-report' })],
    })
    // An explicit Host/user query can still inspect the maintenance situation.
    expect(service.review(target, { situation: 'automation:heartbeat:supervised-growth' }).outcomes).toHaveLength(1)
  })
})
