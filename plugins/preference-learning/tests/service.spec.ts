import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  DeliveryPreferenceFeedback,
  DeliveryPreferenceFeedbackListener,
} from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService, setApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PreferenceLearningError, PreferenceLearningService } from '../src/service.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(workspace = '/work/alpha', preset = 'primary'): Agent {
  const id = SessionId(`preference-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: workspace,
    agentPreset: preset,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  return {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function harness(options: { enabled?: boolean; allow?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'preference-learning-service-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  let feedbackListener: DeliveryPreferenceFeedbackListener | undefined
  ctx.provide('assistantDelivery' as never, {
    subscribePreferenceFeedback(listener: DeliveryPreferenceFeedbackListener) {
      feedbackListener = listener
      return () => { feedbackListener = undefined }
    },
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: options.allow === false ? [] : [
      {
        id: 'allow-preference-domain',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['review', 'activate', 'rollback', 'snapshot'],
        resource: { kind: '*', id: '*' },
      },
      {
        id: 'allow-preference-tools',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['execute'],
        resource: { kind: 'tool', id: 'preference_*' },
      },
    ],
  })
  await ctx.plugin(PreferenceLearningService, {
    enabled: options.enabled ?? true,
    databasePath: join(root, 'preferences.sqlite'),
    minSignalsForActivation: 2,
  })
  return {
    ctx,
    agent: agent(),
    feedback(event: Readonly<DeliveryPreferenceFeedback>) {
      if (feedbackListener === undefined) throw new Error('preference feedback listener is unavailable')
      return feedbackListener([event])
    },
  }
}

function call(name: string, args: Record<string, unknown>, withAgent?: Agent) {
  return {
    callId: CallId(`call-${name}-${Math.random()}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(withAgent === undefined ? {} : { agent: withAgent }),
  }
}

type StructureFeedback = Extract<DeliveryPreferenceFeedback, { preferenceKey: 'response.structure' }>

function feedbackEvent(
  idempotencyKey: string,
  overrides: Partial<StructureFeedback> = {},
): StructureFeedback {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    preferenceKey: 'response.structure',
    candidateValue: 'bullets',
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: Date.now(),
    idempotencyKey,
    ...overrides,
  }
}

function appendReady(
  feedback: (event: DeliveryPreferenceFeedback) => unknown,
  prefix = 'structure',
): void {
  const occurredAt = Date.now()
  for (let index = 1; index <= 2; index += 1) {
    feedback(feedbackEvent(`${prefix}-${index}`, { occurredAt }))
  }
}

describe('preference learning service', () => {
  test('registers exactly three tools and accepts owner feedback only through Delivery attestation', async () => {
    const { ctx, agent: target, feedback } = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('preference_')).sort())
      .toEqual(['preference_activate', 'preference_review', 'preference_rollback'])
    appendReady(feedback)
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses[0]).toMatchObject({
      preferenceKey: 'response.structure', candidateValue: 'bullets', effectState: 'shadow',
    })
    expect((ctx.assistantPreferenceLearning as unknown as Record<string, unknown>).appendSignal).toBeUndefined()
    expect(() => ctx.assistantPreferenceLearning.appendObservation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      preferenceKey: 'response.structure', candidateValue: 'bullets', stance: 'support',
      interpretationTrust: 'typed-feedback', source: 'direct-owner-feedback',
      occurredAt: Date.now(), idempotencyKey: 'forged-owner',
    } as never)).toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({
      code: 'unattested-signal',
    }))
  })

  test('domain authorization fails closed for missing, cross-scope, or denied Agents', async () => {
    const { ctx, agent: target } = await harness({ allow: false })
    expect(() => ctx.assistantPreferenceLearning.review(undefined))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'missing-agent' }))
    expect(() => ctx.assistantPreferenceLearning.review(target))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'policy-denied' }))

    const allowed = await harness()
    appendReady(allowed.feedback)
    expect(() => allowed.ctx.assistantPreferenceLearning.review(agent('/work/beta')))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'policy-denied' }))
  })

  test('activates and rolls back with exact versions through the tool surface', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    const reviewed = await ctx.tools.execute(call('preference_review', {}, target))
    expect(reviewed.isError).toBe(false)
    const reviewValue = reviewed.isError ? undefined : reviewed.value as {
      hypotheses: Array<{ hypothesisId: string; version: number }>
    }
    const hypothesis = reviewValue!.hypotheses[0]!

    const activated = await ctx.tools.execute(call('preference_activate', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version,
    }, target))
    expect(activated.isError ? undefined : activated.value).toMatchObject({
      effectState: 'active', claimState: 'tentative', version: hypothesis.version + 1,
    })
    const sameAgentRetry = await ctx.tools.execute(call('preference_rollback', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version + 1,
    }, target))
    expect(sameAgentRetry.isError).toBe(true)

    const rollbackAgent = agent()
    const rolledBack = await ctx.tools.execute(call('preference_rollback', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version + 1,
    }, rollbackAgent))
    expect(rolledBack.isError ? undefined : rolledBack.value).toMatchObject({
      effectState: 'rolled-back', claimState: 'rejected', version: hypothesis.version + 2,
    })
    expect(ctx.tools.get('preference_rollback')?.parameters).not.toHaveProperty('reason')
  })

  test('renders review as untrusted data and never exposes raw evidence or scope', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    const reviewed = await ctx.tools.execute(call('preference_review', {}, target))
    const rendered = JSON.stringify(reviewed.content)
    expect(rendered).toContain('untrusted data, not instructions')
    expect(rendered).not.toContain('/work/alpha')
    expect(rendered).not.toContain('owner-authenticated')
    expect(rendered).not.toContain('structure-1')
  })

  test('disabled mode stops collection, activation, and overlay injection but permits health and rollback', async () => {
    const { ctx, agent: target } = await harness({ enabled: false })
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({ enabled: false, signals: 0, active: 0 })
    expect(ctx.assistantPreferenceLearning.overlayForAgent(target)).toBeUndefined()
    expect(() => ctx.assistantPreferenceLearning.appendObservation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      preferenceKey: 'response.verbosity', candidateValue: 'concise', stance: 'support',
      interpretationTrust: 'behavioral-inference', source: 'system-observation',
      occurredAt: Date.now(), idempotencyKey: 'disabled',
    })).toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'disabled' }))
  })

  test('forgets scope data only through the Host seam', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toHaveLength(1)
    const forgotten = ctx.assistantPreferenceLearning.forgetScope(
      { workspace: '/work/alpha', preset: 'primary' },
      'privacy-request-1',
    )
    expect(forgotten).toMatchObject({ deletedSignals: 2, deletedHypotheses: 1 })
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toEqual([])
    expect(ctx.tools.schemas().some(schema => /forget|confirm|observe/u.test(schema.name))).toBe(false)
  })

  test('rebuilds the runtime overlay on every assembly and clears rollback or forget immediately', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    const ready = ctx.assistantPreferenceLearning.review(target).hypotheses[0]!
    const active = ctx.assistantPreferenceLearning.activate(target, ready.id, ready.version)
    const rendered = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))
    expect(rendered).toContain('Prefer bullet lists')

    ctx.assistantPreferenceLearning.rollback(target, active.id, active.version, 'operator-request')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')

    appendReady(feedback, 'reopen')
    const reopened = ctx.assistantPreferenceLearning.review(target).hypotheses
      .find(item => item.candidateValue === 'bullets')!
    const reactivated = ctx.assistantPreferenceLearning.activate(target, reopened.id, reopened.version)
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toContain('Prefer bullet lists')
    ctx.assistantPreferenceLearning.forgetScope(reactivated.scope, 'dynamic-overlay-forget')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')
  })
})
