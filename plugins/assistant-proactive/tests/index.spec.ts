import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import proactive, { AssistantProactiveService, Config, name, version } from '../src/index.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const profile: OpportunityProfile & { mode: 'execute' } = { id: 'report', mode: 'execute', expectedBenefit: 10, successPpm: 1_000_000, executionCost: 1, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 60_000, maxDecisionsPerGoal: 10, maxExecutionsPerGoal: 2, maxRemindersPerGoal: 0 }
const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const opportunity = (): OpportunityInput => ({ waitId: 'wait', profileId: 'report', scope, goalId: 'goal', sessionId: 'session', definitionDigest: 'definition', objective: 'Update the report', nativeGoalId: 'native', nativeRevision: 1, ownerRouteId: 'route', sourceDigest: 'source-digest', sourceId: 'event-triggers:report', event: { id: 'event', sequence: 1, digest: 'digest', occurredAt: Date.now() }, expiresAt: Date.now() + 60_000 })
async function harness(profiles: OpportunityProfile[] = [profile]) {
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('tools' as never, { register: () => () => {} } as never)
  const agent = { id: 'agent', session: { header: { cwd: scope.workspace, agentPreset: scope.preset } } } as unknown as Agent
  let principalVersion = 1; let ownerTurn = true; let allowed = true
  const preauthorized: { name?: string; callerFiberName?: string; authorize?: (execution: ToolExecution) => boolean } = {}
  const principal = () => ({ principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion }, scope: { workspace: scope.workspace, preset: scope.preset } })
  ctx.provide('agents' as never, { get: () => agent } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: () => ownerTurn ? principal() : undefined } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: allowed ? 'allow' : 'deny' }), evaluateAgent: () => ({ effect: allowed ? 'allow' : 'deny' }),
    contextToolPreauthorizationVersion: () => 1,
    registerPreauthorizedTool: (_caller: Context, definition: { name: string }, authorize: (execution: ToolExecution) => boolean) => {
      preauthorized.name = definition.name; preauthorized.callerFiberName = _caller.fiber.name; preauthorized.authorize = authorize; return () => {}
    } } as never)
  await ctx.plugin(proactive, { databasePath: ':memory:', profiles })
  return { ctx, agent, preauthorized, service: ctx.assistantProactive, revoke: () => { principalVersion++ }, deny: () => { allowed = false }, background: () => { ownerTurn = false } }
}
describe('assistant-proactive bundle and owner access', () => {
  it('loads and disposes independently without optional execution services', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(name).toBe('dsh-enhanced-assistant-proactive'); expect(version).toBe(manifest.version)
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:' })
    const service = ctx.assistantProactive
    expect(() => service.assertProfile('missing')).toThrow('configured active')
    await ctx.fiber.dispose(); expect(() => service.assertProfile('missing')).toThrow('configured active')
  })
  it('requires live owner identity, policy and a human turn for feedback, and does not transfer records across lineage changes', async () => {
    const f = await harness(); const decision = f.service.evaluate(opportunity()).decision
    expect(f.service.inspect(f.agent)).toHaveLength(1)
    expect(() => f.service.inspect({ ...f.agent } as Agent)).toThrow('exact live agent')
    f.background(); expect(() => f.service.feedback(f.agent, decision.id, 'rejected')).toThrow('current authenticated owner turn')
    f.revoke(); expect(f.service.inspect(f.agent)).toEqual([])
    f.deny(); expect(() => f.service.inspect(f.agent)).toThrow('policy denied')
  })
  it('owner rejection suppresses future execution and acceptance never grants new authority', async () => {
    const f = await harness(); const input = opportunity(); const first = f.service.evaluate(input)
    expect(f.service.feedback(f.agent, first.decision.id, 'rejected')).toMatchObject({ feedback: 'rejected' })
    expect(f.service.evaluate({ ...input, event: { ...input.event, id: 'second', sequence: 2, digest: 'second-digest' } })).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  })
  it('configuration accepts bounded reminders and rejects invalid probability estimates', () => {
    expect(Config({ profiles: [{ ...profile, mode: 'remind' }] }).profiles?.[0]?.mode).toBe('remind')
    expect(() => Config({ profiles: [{ ...profile, successPpm: 1_000_001 }] })).toThrow()
  })
  it('projects only live owner-authorized profile ids, modes and finite limits without model settings', async () => {
    const secret = { ...profile, id: 'draft', mode: 'prepare' as const, preparation: { provider: 'private-provider', model: 'private-model', budgetId: 'private-budget', maxOutputTokens: 20, timeoutMs: 1_000 } }
    const f = await harness([profile, secret])
    expect(f.service.availableProfiles(f.agent)).toEqual([{ id: 'report', mode: 'execute', maxDecisionsPerGoal: 10, maxExecutionsPerGoal: 2, maxRemindersPerGoal: 0 }])
    expect(JSON.stringify(f.service.availableProfiles(f.agent))).not.toMatch(/private-provider|private-model|private-budget/u)
    const valid = { agent: f.agent, arguments: {}, signal: new AbortController().signal }
    await vi.waitFor(() => expect(f.preauthorized.name).toBe('proactive_status'))
    expect(f.preauthorized.callerFiberName).toBe('dsh-enhanced-assistant-proactive')
    expect(f.preauthorized.authorize?.(valid as never)).toBe(true)
    expect(f.service.preauthorizeStatus(valid as never)).toBe(true)
    expect(f.service.preauthorizeStatus({ ...valid, arguments: { goal_id: 'goal' } } as never)).toBe(true)
    expect(f.service.preauthorizeStatus({ ...valid, arguments: { unexpected: true } } as never)).toBe(false)
    const getter = Object.defineProperty({}, 'goal_id', { enumerable: true, get() { throw new Error('read getter') } })
    expect(f.service.preauthorizeStatus({ ...valid, arguments: getter } as never)).toBe(false)
    expect(f.service.preauthorizeStatus({ ...valid, agent: { ...f.agent } } as never)).toBe(false)
    expect(f.service.preauthorizeStatus({ ...valid, signal: AbortSignal.abort() } as never)).toBe(false)
    f.background(); expect(f.service.preauthorizeStatus(valid as never)).toBe(true)
    f.revoke(); expect(f.service.availableProfiles(f.agent)).toHaveLength(1)
    f.deny(); expect(() => f.service.availableProfiles(f.agent)).toThrow('policy denied')
    expect(f.service.preauthorizeStatus(valid as never)).toBe(false)
  })
  it('keeps an empty profile configuration inert', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const f = await harness([])
      expect(f.service.availableProfiles(f.agent)).toEqual([])
      expect(() => f.service.assertProfile('report')).toThrow('configured active')
      expect(intervalSpy).not.toHaveBeenCalled()
    } finally {
      intervalSpy.mockRestore()
    }
  })
  it('exposes Host-only draft inspection and resolution without requiring an active agent', async () => {
    const prepareProfile: OpportunityProfile = {
      ...profile,
      id: 'prepare-draft',
      mode: 'prepare',
      preparation: { provider: 'mock', model: 'draft', budgetId: 'prep', maxOutputTokens: 128, timeoutMs: 5_000 },
    }
    const f = await harness([prepareProfile])
    const runPreparation = vi.fn(async () => ({
      outcome: 'succeeded',
      output: 'Suggested diff ready',
      usage: { outputTokens: 12 },
      sessionId: 'prep-session-1',
      quiescent: true,
    }))
    f.ctx.provide('assistantAutomations' as never, { runPreparation } as never)
    f.ctx.provide('assistantGoals' as never, { assertPreparationCurrent: vi.fn() } as never)

    const input = { ...opportunity(), profileId: 'prepare-draft' }
    const evaluated = f.service.evaluate(input)
    expect(evaluated.disposition).toBe('consume')
    await vi.waitFor(() => expect(f.service.inspectDrafts({ state: 'draft' })).toHaveLength(1))

    const drafts = f.service.inspectDrafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      id: evaluated.decision.id,
      goalId: input.goalId,
      profileId: 'prepare-draft',
      objective: input.objective,
      state: 'draft',
      reason: 'unverified-draft',
      decisionState: 'decided',
      output: 'Suggested diff ready',
      sessionId: 'prep-session-1',
      verified: false,
    })

    const opportunities = f.service.inspectOpportunities({ workspace: scope.workspace, mode: 'prepare' })
    expect(opportunities).toHaveLength(1)
    expect(opportunities[0]?.preparation).toMatchObject({ state: 'draft', output: 'Suggested diff ready', verified: false })

    expect(f.service.resolveDraft({ id: 'missing-id', decision: 'accepted' })).toBeUndefined()
    const rejected = f.service.resolveDraft({ id: evaluated.decision.id, decision: 'rejected' })
    expect(rejected).toMatchObject({ id: evaluated.decision.id, state: 'closed', feedback: 'rejected' })
    expect(f.service.resolveDraft({ id: evaluated.decision.id, decision: 'rejected' })).toMatchObject({ state: 'closed', feedback: 'rejected' })
    expect(() => f.service.resolveDraft({ id: evaluated.decision.id, decision: 'accepted' })).toThrow('unavailable')
    expect(f.service.inspectDrafts()[0]).toMatchObject({ feedback: 'rejected', decisionState: 'closed' })

    const second = f.service.evaluate({ ...input, event: { ...input.event, id: 'event-2', sequence: 2, digest: 'digest-2' } })
    expect(second.decision).toMatchObject({ mode: 'suppress', reason: 'rejected-cooldown' })
  })
  it('exposes Host-only WP22 owner attention question inspection and reply application', async () => {
    const f = await harness()
    expect(f.service.inspectAttentionQuestions()).toEqual([])
    expect(f.service.resolveAttentionQuestion({ scope: { workspace: scope.workspace, preset: scope.preset }, questionId: 'q-1', choice: 'decline' }))
      .toEqual({ status: 'rejected', reason: 'evaluation-unavailable' })

    f.service.evaluate(opportunity())
    const applyReply = vi.fn(() => ({
      status: 'applied' as const,
      questionId: 'q-open',
      choice: 'authorize-once' as const,
      proposalId: 'p-1',
      grantId: 'g-once',
      adoption: 'deferred' as const,
    }))
    f.ctx.provide('assistantEvaluation' as never, {
      attentionLooseningStatus: vi.fn(() => ({
        enabled: true,
        grant: null,
        proposals: [{ proposalId: 'p-1', decision: null }],
        questions: [{
          questionId: 'q-open',
          question: {
            proposalId: 'p-1',
            change: { parameter: 'minimumUtilityDelta', parentValue: 0, candidateValue: -5, delta: -5 },
            exceeded: ['no-grant'],
            grantId: null,
            choices: ['authorize-once', 'decline'] as const,
            createdAt: 1_700_000_000_000,
          },
        }],
      })),
      attentionOwnerQuestionStatus: vi.fn(() => ({
        enabled: true,
        deliveries: [{ questionId: 'q-open', status: 'queued' as const, outboxId: 'out-1', recordedAt: 1_700_000_000_100 }],
        replies: [],
      })),
      applyAttentionOwnerQuestionReply: applyReply,
    } as never)

    const questions = f.service.inspectAttentionQuestions()
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({
      questionId: 'q-open',
      scope: { workspace: scope.workspace, preset: scope.preset },
      proposalId: 'p-1',
      parameter: 'minimumUtilityDelta',
      parentValue: 0,
      candidateValue: -5,
      delta: -5,
      exceeded: ['no-grant'],
      open: true,
      delivery: { status: 'queued', outboxId: 'out-1' },
      reply: null,
    })

    const resolved = f.service.resolveAttentionQuestion({
      scope: { workspace: scope.workspace, preset: scope.preset },
      questionId: 'q-open',
      choice: 'authorize-once',
    })
    expect(resolved).toMatchObject({ status: 'applied', questionId: 'q-open', choice: 'authorize-once', grantId: 'g-once' })
    expect(applyReply).toHaveBeenCalledWith({
      scope: { workspace: scope.workspace, preset: scope.preset },
      cohort: { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' },
      questionId: 'q-open',
      choice: 'authorize-once',
    })
  })
})
