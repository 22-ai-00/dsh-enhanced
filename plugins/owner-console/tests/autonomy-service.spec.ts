import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { OwnerConsoleService } from '../src/service.ts'
import { OwnerConsoleAssistantOverviewSchema, WRITE_RESULT } from '../src/typert.ts'

describe('owner console autonomy & dreaming overview/action RPCs', () => {
  it('returns absent subsystems cleanly when autonomy plugins are not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const console = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const overview = OwnerConsoleAssistantOverviewSchema.parse(await console.assistantOverview('', ''))
      expect(overview.dreaming.state).toBe('absent')
      expect(overview.proactive.state).toBe('absent')
      expect(overview.workItems.state).toBe('absent')
      expect(overview.memoryLearning.state).toBe('absent')
      expect(overview.growthDriver.state).toBe('absent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aggregates Stage B dreaming/proactive/work-items/learning/growth state and executes exact #56/#57 actions', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)

    const acknowledgeIdea = vi.fn(({ ideaId, note }: { ideaId: string; note?: string }) => ({
      idea: { id: ideaId, state: 'owner-acknowledged' },
      event: { ideaId, state: 'owner-acknowledged', actor: 'owner', at: 100, note },
    }))
    const transitionIdea = vi.fn(({ ideaId, transition, note }: { ideaId: string; transition: string; note?: string }) => ({
      idea: { id: ideaId, state: transition === 'validate' ? 'validated' : transition === 'reject' ? 'rejected' : 'withdrawn' },
      event: { ideaId, state: 'validated', actor: 'owner', at: 200, note },
    }))
    const retire = vi.fn()
    ctx.provide('assistantDreaming' as never, {
      health: () => ({
        enabled: true, scheduler: 'active', lastRunAt: 1_000, lastRunOutcome: 'succeeded',
        lastSkipReason: null, counts: { runs: 2, ideas: 1, recorded: 1 },
      }),
      inspectIdeas: () => [{
        id: 'idea-1', runId: 'run-1', createdAt: 1_000, dayKey: '2026-11-17', state: 'recorded',
        summary: 'Add git-diff summary skill', detail: 'Repeated manual diff checks detected', evidenceRefs: ['sha256:a'],
      }],
      acknowledgeIdea,
      transitionIdea,
      retire,
    } as never)

    const resolveDraft = vi.fn(() => ({ id: 'draft-1', action: 'accept', verified: false }))
    const resolveAttentionQuestion = vi.fn(() => ({ status: 'applied', questionId: 'q-1', choice: 'authorize-once' }))
    ctx.provide('assistantProactive' as never, {
      intakeEvaluationHealth: () => ({ enabled: true, registered: true, callsLastHour: 2, consecutiveFailures: 0 }),
      inspectDrafts: () => [{
        id: 'draft-1', goalId: 'goal-1', profileId: 'default', objective: 'Prepare release checklist',
        preparationState: 'draft', verified: false, updatedAt: 2_000, result: { output: 'Checklist draft ready' },
      }],
      resolveDraft,
      inspectAttentionQuestions: () => ({
        available: true,
        cohort: { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' },
        items: [{
          questionId: 'q-1',
          proposalId: 'prop-1',
          scope: { workspace: '/ws/demo', preset: 'standard' },
          cohort: { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' },
          open: true,
          actionable: true,
          question: { change: { parameter: 'minimumUtilityDelta', from: 10, to: 5 } },
          delivery: { status: 'queued', recordedAt: 3_000 },
          reply: undefined,
        }],
      }),
      resolveAttentionQuestion,
    } as never)

    ctx.provide('assistantWorkItems' as never, {
      health: () => ({
        enabled: true, mode: 'observe', openItems: 1, workerConnected: true, ownerRouteValid: true,
        lastAdmitAt: 2_500, evaluation: { pending: 0 },
      }),
      intakeEvaluationHealth: () => ({ enabled: true, evaluated: 4 }),
      inspectIntakeQueue: () => ({
        enabled: true, mode: 'observe', intakeLedgerEnabled: true, evaluationEnabled: true,
        admit: { enabled: true, mode: 'observe', kind: 'task', maxPerHour: 10, hasAcceptanceObjective: true },
        counts: { intake: 3, evaluations: 2, admissions: 1, pendingAdmissions: 0 },
        admissions: [{
          source: 'lark-channel', sourceEventId: 'evt-1', ruleId: 'default', policyVersion: '1',
          mode: 'observe', outcome: 'would-admit', reasonCode: null, observeReason: 'configured-observe',
          decisionId: 'dec-1', itemId: null, recordedAt: 4_000,
        }],
        observedItems: [{
          id: 'obs-1', kind: 'task', externalId: 'ext-1', title: 'Investigate slow test',
          state: 'observed', stateReason: 'observe-mode', wouldReject: [], createdAt: 4_500,
        }],
      }),
    } as never)

    ctx.provide('assistantMemoryLearning' as never, {
      health: () => ({
        enabled: true, connected: true, available: true, remainingExtractions: 7,
        lastScanAt: 5_000, lastError: null, counts: { adopted: 2, queued: 1, rejected: 0 },
      }),
    } as never)

    ctx.provide('assistantGrowthDriver' as never, {
      health: () => ({
        lastWakeAt: 6_000, outcome: 'ran', reason: 'succeeded',
        run: { outcome: 'succeeded' },
        dreamingIntake: { enabled: true, considered: 2, ingested: 1, rejectedUnvalidated: 1, ideaIds: ['idea-1'] },
      }),
      usageHealth: () => ({
        enabled: true, connected: true, lastScanAt: 6_100, lastError: null, counts: { reviewed: 3 },
      }),
    } as never)

    ctx.provide('loader' as never, {
      entries: () => [{
        id: 'include:dsh-enhanced-assistant-dreaming',
        options: { id: 'dsh-enhanced-assistant-dreaming', name: '@dsh-enhanced/assistant-dreaming', disabled: false,
          config: { scope: { workspace: '/ws/demo', preset: 'standard' } } },
        refresh: async () => undefined,
      }],
    } as never)

    const console = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const overview = OwnerConsoleAssistantOverviewSchema.parse(await console.assistantOverview('', ''))
      expect(overview.resolvedScope).toEqual({ workspace: '/ws/demo', preset: 'standard' })
      expect(overview.dreaming).toMatchObject({
        state: 'ok', canAcknowledge: true, canValidate: true, canReject: true, canRetire: true,
        health: { runs: 2, ideas: 1, recorded: 1 },
      })
      expect(overview.dreaming.ideas).toHaveLength(1)
      expect(overview.proactive).toMatchObject({ state: 'ok', canResolveDraft: true })
      expect(overview.proactive.drafts[0]).toMatchObject({ id: 'draft-1', state: 'draft', verified: false, outputPreview: 'Checklist draft ready' })
      expect(overview.proactive.attentionQuestions[0]).toMatchObject({
        questionId: 'q-1', actionable: true, questionSummary: 'minimumUtilityDelta: 10 → 5',
      })
      expect(overview.workItems.health).toMatchObject({
        enabled: true, mode: 'observe', admitMode: 'observe', hasAcceptanceObjective: true, pendingAdmissions: 0,
      })
      expect(overview.workItems.queue.map(q => q.id)).toEqual(['obs-1', 'evt-1'])
      expect(overview.memoryLearning.health).toMatchObject({ remainingExtractions: 7, available: true })
      expect(overview.growthDriver.health?.dreamingIntake).toEqual({
        enabled: true, considered: 2, ingested: 1, rejectedUnvalidated: 1,
      })

      expect(WRITE_RESULT.parse(await console.actDreamingIdea('idea-1', 'acknowledge', 'seen')).applied).toBe(true)
      expect(acknowledgeIdea).toHaveBeenCalledWith({ ideaId: 'idea-1', note: 'seen' })

      expect(WRITE_RESULT.parse(await console.actDreamingIdea('idea-1', 'validate', 'approved')).applied).toBe(true)
      expect(transitionIdea).toHaveBeenCalledWith({ ideaId: 'idea-1', transition: 'validate', note: 'approved' })

      expect(WRITE_RESULT.parse(await console.actDreamingIdea('', 'retire', '')).applied).toBe(true)
      expect(retire).toHaveBeenCalledOnce()

      expect(WRITE_RESULT.parse(await console.actProactiveDraft('draft-1', 'accept', '', '')).applied).toBe(true)
      expect(resolveDraft).toHaveBeenCalledWith({ id: 'draft-1', action: 'accept', workspace: '/ws/demo', preset: 'standard' })

      expect(WRITE_RESULT.parse(
        await console.actAttentionQuestion('/ws/demo', 'standard', 'owner-notification', 'assistant-proactive/v1', 'q-1', 'authorize-once'),
      ).applied).toBe(true)
      expect(resolveAttentionQuestion).toHaveBeenCalledWith({
        workspace: '/ws/demo', preset: 'standard', questionId: 'q-1', choice: 'authorize-once',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('isolates failing subsystem reads without breaking the rest of assistantOverview', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('assistantDreaming' as never, {
      health: () => { throw new Error('sqlite corrupt') },
    } as never)
    ctx.provide('assistantWorkItems' as never, {
      health: () => ({ enabled: false, mode: 'observe', openItems: 0, workerConnected: false, ownerRouteValid: false, evaluation: { pending: 0 } }),
    } as never)
    const console = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const overview = OwnerConsoleAssistantOverviewSchema.parse(await console.assistantOverview('/ws', 'standard'))
      expect(overview.dreaming.state).toBe('error')
      expect(overview.dreaming.note).toContain('sqlite corrupt')
      expect(overview.workItems.state).toBe('disabled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('consumes live B4 assistantProactive array & assistantWorkItems recent/listObservedItems shapes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)

    ctx.provide('assistantProactive' as never, {
      intakeEvaluationHealth: () => ({ enabled: true, registered: true, callsLastHour: 1, consecutiveFailures: 0 }),
      inspectDrafts: () => [{
        id: 'draft-live-1', goalId: 'goal-live-1', profileId: 'prep-live', objective: 'Draft checklist',
        state: 'draft', reason: 'unverified-draft', decisionState: 'decided',
        createdAt: 1_000, updatedAt: 2_000, deadlineAt: 9_000, output: 'Live output preview', verified: false,
      }],
      resolveDraft: vi.fn(),
      inspectAttentionQuestions: () => [{
        questionId: 'q-live-1',
        scope: { workspace: '/ws/live', preset: 'standard' },
        proposalId: 'prop-live-1',
        parameter: 'minimumUtilityDelta',
        parentValue: 10,
        candidateValue: 4,
        delta: -6,
        exceeded: ['no-grant'],
        choices: ['authorize-once', 'decline'],
        delivery: null,
        reply: null,
        decision: null,
        open: true,
        createdAt: 3_000,
      }],
    } as never)

    ctx.provide('assistantWorkItems' as never, {
      health: () => ({
        enabled: true, mode: 'observe', openItems: 0, workerConnected: true, ownerRouteValid: true,
        evaluation: { pending: 1 },
      }),
      inspectIntakeQueue: () => ({
        enabled: true,
        intakeCounts: { stored: 2, duplicate: 0, filtered: 0 },
        evaluationCounts: { decided: 2, unavailable: 0 },
        admissionCounts: { 'would-admit': 2, admitted: 0, replayed: 0, refused: 0 },
        pendingEvaluations: 0,
        pendingAdmissions: 1,
        mode: 'observe',
        lastEvaluationError: null,
        lastAdmissionError: null,
        recent: [{
          source: 'lark-channel', sourceEventId: 'evt-live-1', ruleId: 'rule-1', policyVersion: 'v1',
          mode: 'observe', outcome: 'would-admit', reasonCode: null, observeReason: 'configured-observe',
          decisionId: 'dec-live-1', itemId: null, recordedAt: 4_000, level: 'accept', wouldAccept: true,
        }],
      }),
      listObservedItems: () => [{
        source: 'lark-channel', sourceEventId: 'evt-live-1', ruleId: 'rule-1', policyVersion: 'v1',
        decisionId: 'dec-live-1', configuredMode: 'observe', observeReason: 'configured-observe',
        recordedAt: 4_000, level: 'accept', occurredAt: 3_900,
      }, {
        source: 'lark-channel', sourceEventId: 'evt-live-2', ruleId: 'rule-2', policyVersion: 'v1',
        decisionId: 'dec-live-2', configuredMode: 'auto', observeReason: 'missing-acceptance',
        recordedAt: 3_500, level: 'accept', occurredAt: 3_400,
      }],
    } as never)

    const console = new OwnerConsoleService(ctx, { feishuAppId: '' })
    try {
      const overview = OwnerConsoleAssistantOverviewSchema.parse(await console.assistantOverview('/ws/live', 'standard'))
      expect(overview.proactive.drafts[0]).toMatchObject({
        id: 'draft-live-1', state: 'draft', outputPreview: 'Live output preview', verified: false,
      })
      expect(overview.proactive.attentionQuestions[0]).toMatchObject({
        questionId: 'q-live-1', actionable: true, open: true, deliveryStatus: 'queued',
        questionSummary: 'minimumUtilityDelta: 10 → 4',
      })
      expect(overview.workItems.health).toMatchObject({
        intakeLedgerEnabled: true, admitMode: 'observe', pendingAdmissions: 1,
      })
      expect(overview.workItems.queue.map(q => q.id)).toEqual(['evt-live-1', 'evt-live-2'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
