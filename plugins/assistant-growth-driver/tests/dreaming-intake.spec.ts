import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantDreamingService, DreamStore } from '@dsh-enhanced/assistant-dreaming'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGrowthDriverService, normalizeConfig, type GrowthAuthority } from '../src/index.ts'
import { assertValidatedDreamIdeaInput, readValidatedDreamIdeas } from '../src/dreaming-intake.ts'
import { runGrowthAgent } from '../src/growth-agent.ts'

const PRINCIPAL = 'owner-1'
const RECORD_ID = 'record-owner-1'
const OWNER_ROUTE = 'owner-route'
const PRESET = 'primary'
const REF_HEX = 'a'.repeat(64)

class NoToolStopAdapter extends LlmAdapter {
  readonly messageTranscripts: string[] = []
  readonly toolNames: string[][] = []

  override async resolveModel(provider: string, model: string) {
    return {
      ...await super.resolveModel(provider, model),
      reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.toolNames.push((options.tools ?? []).map(t => t.name).sort())
    this.messageTranscripts.push(JSON.stringify(options.messages))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reviewed validated dreaming leads' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function ownerScope(workspace: string): GoalScope {
  return Object.freeze({
    principalId: PRINCIPAL,
    principalRecordId: RECORD_ID,
    principalVersion: 1,
    workspace,
    preset: PRESET,
  })
}

function activeAuthority(): GrowthAuthority {
  return {
    id: 'growth-auth-1',
    scope: ownerScope('/tmp/dream-intake-test'),
    ownerRouteId: OWNER_ROUTE,
    expiresAt: Date.now() + 60_000,
    assertCurrent: () => {},
  }
}

describe('dreamingIdeas config validation', () => {
  it('defaults on and enforces enabled/scope invariants, cascade opt-out, and bounds', () => {
    expect(normalizeConfig().dreamingIdeas).toEqual({ enabled: true, maxIdeasPerWake: 3 })
    expect(normalizeConfig({ enabled: false }).dreamingIdeas).toEqual({ enabled: false, maxIdeasPerWake: 3 })
    expect(normalizeConfig({ dreamingIdeas: { enabled: false } }).dreamingIdeas).toEqual({ enabled: false, maxIdeasPerWake: 3 })
    expect(() => normalizeConfig({ enabled: false, dreamingIdeas: { enabled: true } })).toThrow(/dreamingIdeas\.enabled requires the driver itself/u)
    expect(() => normalizeConfig({ dreamingIdeas: { enabled: true } })).toThrow(/explicit owner scope/u)
    expect(() => normalizeConfig({ enabled: true, dreamingIdeas: { enabled: true } })).toThrow(/explicit owner scope/u)
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: '/tmp/ws', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' },
      dreamingIdeas: { enabled: true, maxIdeasPerWake: 0 },
    })).toThrow()
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: '/tmp/ws', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' },
      dreamingIdeas: { enabled: true, maxIdeasPerWake: 11 },
    })).toThrow()
    const valid = normalizeConfig({
      enabled: true,
      scope: { workspace: '/tmp/ws', preset: 'primary', principalId: 'owner', ownerRouteId: 'route' },
      dreamingIdeas: { enabled: true, maxIdeasPerWake: 2 },
    })
    expect(valid.dreamingIdeas).toEqual({ enabled: true, maxIdeasPerWake: 2 })
  })
})

describe('dreaming-intake fail-closed filtering', () => {
  it('returns disabled empty result when assistantDreaming is absent or disabled', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(readValidatedDreamIdeas(ctx, activeAuthority(), 3)).toEqual({
      ideas: [],
      summary: { enabled: false, considered: 0, ingested: 0, rejectedUnvalidated: 0, ideaIds: [] },
    })

    ctx.provide('assistantDreaming' as never, {
      health: () => ({ enabled: false }),
      inspectValidatedIdeas: () => [{ id: 'should-ignore', state: 'validated' }],
    } as never)
    expect(readValidatedDreamIdeas(ctx, activeAuthority(), 3)).toEqual({
      ideas: [],
      summary: { enabled: false, considered: 0, ingested: 0, rejectedUnvalidated: 0, ideaIds: [] },
    })
  })

  it('rejects unvalidated, withdrawn, rejected, host-validated and malformed ideas while respecting maxIdeasPerWake', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const mk = (id: string, state: string, summary = `Summary ${id}`) => ({
      id,
      lane: 'lane-1',
      runId: 'run-1',
      createdAt: 1_700_000_000_000,
      dayKey: '2026-11-16',
      state,
      summary,
      detail: `Detail for ${id}`,
      evidenceRefs: [REF_HEX],
    })
    const eventsById = new Map<string, Array<{ ideaId: string; state: string; actor: 'owner' | 'host'; at: number }>>([
      ['v-ok-1', [
        { ideaId: 'v-ok-1', state: 'recorded', actor: 'host', at: 1 },
        { ideaId: 'v-ok-1', state: 'validated', actor: 'owner', at: 2 },
      ]],
      ['v-host-only', [
        { ideaId: 'v-host-only', state: 'recorded', actor: 'host', at: 1 },
        { ideaId: 'v-host-only', state: 'validated', actor: 'host', at: 2 },
      ]],
      ['v-withdrawn-tail', [
        { ideaId: 'v-withdrawn-tail', state: 'recorded', actor: 'host', at: 1 },
        { ideaId: 'v-withdrawn-tail', state: 'validated', actor: 'owner', at: 2 },
        { ideaId: 'v-withdrawn-tail', state: 'withdrawn', actor: 'owner', at: 3 },
      ]],
      ['v-ok-2', [
        { ideaId: 'v-ok-2', state: 'recorded', actor: 'host', at: 1 },
        { ideaId: 'v-ok-2', state: 'validated', actor: 'owner', at: 2 },
      ]],
      ['v-ok-3', [
        { ideaId: 'v-ok-3', state: 'recorded', actor: 'host', at: 1 },
        { ideaId: 'v-ok-3', state: 'validated', actor: 'owner', at: 2 },
      ]],
    ])
    ctx.provide('assistantDreaming' as never, {
      health: () => ({ enabled: true }),
      inspectIdeas: () => [
        mk('rec-1', 'recorded'),
        mk('ack-1', 'owner-acknowledged'),
        mk('rej-1', 'rejected'),
        mk('wd-1', 'withdrawn'),
        mk('bad-ref', 'validated'),
        mk('v-host-only', 'validated'),
        mk('v-withdrawn-tail', 'validated'),
        mk('v-ok-1', 'validated'),
        mk('v-ok-2', 'validated'),
        mk('v-ok-3', 'validated'),
      ].map(item => item.id === 'bad-ref' ? { ...item, evidenceRefs: ['not-a-hex-digest'] } : item),
      inspectIdeaEvents: (ideaId: string) => eventsById.get(ideaId) ?? [],
    } as never)

    const result = readValidatedDreamIdeas(ctx, activeAuthority(), 2)
    expect(result.ideas.map(i => i.id)).toEqual(['v-ok-1', 'v-ok-2'])
    expect(result.summary).toEqual({
      enabled: true,
      considered: 9,
      ingested: 2,
      rejectedUnvalidated: 7,
      ideaIds: ['v-ok-1', 'v-ok-2'],
    })
  })

  it('rejects direct unvalidated idea injection and authority expiration cleanly', async () => {
    expect(() => assertValidatedDreamIdeaInput({
      id: 'i-1',
      lane: 'l-1',
      createdAt: 100,
      dayKey: '2026-11-16',
      state: 'recorded',
      summary: 'unvalidated',
      detail: 'should never pass',
      evidenceRefs: [REF_HEX],
    })).toThrow(/refusing unvalidated dreaming idea/u)

    const ctx = new Context()
    contexts.push(ctx)
    await expect(runGrowthAgent(ctx, {
      wakeId: 'w-fail',
      authority: activeAuthority(),
      config: normalizeConfig({
        enabled: true,
        scope: { workspace: '/tmp/dream-intake-test', preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      }),
      model: { provider: 'test-provider', model: 'test-model' },
      goals: { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: async () => { throw new Error('unused') } },
      skills: {
        inspectOwnerActiveSkills: () => [],
        inspectOwnerSkillCandidates: () => [],
        stageOwnerVerifiedSuccessCandidate: () => { throw new Error('unused') },
      },
      validatedDreamIdeas: [{
        id: 'i-1',
        state: 'recorded' as unknown as 'validated',
        lane: 'l-1',
        dayKey: '2026-11-16',
        createdAt: 100,
        summary: 'sneaky unvalidated',
        detail: 'd',
        evidenceRefs: [REF_HEX],
        digest: REF_HEX,
      }],
    })).rejects.toThrow(/refusing unvalidated dreaming idea/u)

    const expired = {
      ...activeAuthority(),
      assertCurrent: () => { throw new Error('authority expired') },
    }
    expect(() => readValidatedDreamIdeas(ctx, expired, 3)).toThrow(/authority expired/u)
  })
})

describe('end-to-end dreaming -> growth-driver intake integration', () => {
  it('ingests only owner-validated dreaming ideas under policy/budget/tool-surface gates and omits unvalidated ideas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'growth-dream-int-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)

    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    const adapter = new NoToolStopAdapter()
    ctx.llm.registerAdapter(['test-provider'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })

    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: (req: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => Object.freeze({
        receiptVersion: 2,
        authorityId: req.authorityId,
        authorityHash: 'a'.repeat(64),
        principalId: req.principalId,
        principalRecordId: RECORD_ID,
        principalVersion: 1,
        workspace: req.workspace,
        agentPreset: req.agentPreset,
        bindingVersion: 1,
        generation: 1,
      }),
      inspectOwnerRouteState: () => ({ status: 'active' }),
      inspectOwnerModelSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
      resolveOwnerRoute: () => ({ binding: { sessionId: 'owner-sess' } }),
      enqueueOwnerNotification: () => ({ id: 'notif-1' }),
    } as never)
    ctx.provide('assistantEvaluation' as never, {
      canonicalHostScope: (input: { workspace: string; preset: string }) => Object.freeze({ ...input }),
      listTrustedTaskLearningProjections: () => Object.freeze({ items: [] }),
    } as never)
    ctx.provide('assistantGoals' as never, {
      inspectOwnerGoals: () => [],
      inspectOwnerVerifiedWorkflowSource: async () => { throw new Error('no goals expected') },
    } as never)
    ctx.provide('assistantAutomations' as never, {
      registerHostExecutor: () => () => {},
      reconcileSystem: (input: { automationId: string; desiredStatus?: string }) => ({ id: input.automationId, status: input.desiredStatus ?? 'active' }),
    } as never)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [
        { id: 'growth-budget', metric: 'automation-runs', limit: 1, periodMs: 60_000, scope: 'workspace' },
        { id: 'dream-budget', metric: 'automation-runs', limit: 5, periodMs: 60_000, scope: 'workspace' },
      ],
      rules: [
        {
          id: 'dream-reconcile', effect: 'allow',
          subject: { kind: 'background', id: 'assistant-dreaming', workspace: root, principal: PRINCIPAL },
          actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] },
        },
        {
          id: 'dream-execute', effect: 'allow',
          subject: { kind: 'background', id: '*', workspace: root, principal: PRINCIPAL },
          actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] },
        },
        {
          id: 'dream-owner-transitions', effect: 'allow',
          subject: { kind: 'external', id: PRINCIPAL, workspace: root, principal: PRINCIPAL },
          actions: ['dream.acknowledge', 'dream.validate', 'dream.reject', 'dream.retire'],
          resource: { kind: 'evolution', id: 'assistant-dreaming:idea:*' }, context: { initiators: ['foreground'] },
        },
        {
          id: 'growth-draft', effect: 'allow',
          subject: { kind: 'agent', id: PRESET, workspace: root, principal: PRINCIPAL },
          actions: ['draft'], resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiators: ['background'] },
        },
        {
          id: 'growth-tool-execute', effect: 'allow',
          subject: { kind: 'agent', id: PRESET, workspace: root, principal: PRINCIPAL },
          actions: ['execute'], resource: { kind: 'tool', id: 'growth_*' }, context: { initiators: ['background'] },
        },
      ],
    })
    await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'] })
    await vi.waitFor(() => {
      const tools = ctx.get('tools' as never) as { schemas: () => Array<{ name: string }> } | undefined
      if (tools === undefined || !tools.schemas().some(schema => schema.name === 'skill_save')) {
        throw new Error('assistant-skills global tools not ready')
      }
    }, { timeout: 2_000 })

    // Seed DreamStore directly with fresh (within retentionDays) ideas before mounting AssistantDreamingService.
    const now = Date.now()
    const dayKey = new Date(now).toISOString().slice(0, 10)
    const dreamDbPath = join(root, 'dream.sqlite')
    const dreamScope = { workspace: root, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE }
    const dreamLane = acceptanceDigest({ scope: dreamScope, databasePath: dreamDbPath }).slice(0, 40)
    const store = new DreamStore(dreamDbPath, dreamLane)
    store.beginDream('run-seed', 1, dayKey, now - 10_000, 'd'.repeat(64))
    store.recordIdea({
      id: 'idea-validated',
      runId: 'run-seed',
      createdAt: now - 9_000,
      dayKey,
      summary: 'VALIDATED_IDEA_EXTRACT_CSV_HELPER',
      detail: 'Repeated CSV normalization steps observed across recent reports.',
      evidenceRefs: [REF_HEX],
    })
    store.recordIdea({
      id: 'idea-unvalidated',
      runId: 'run-seed',
      createdAt: now - 8_000,
      dayKey,
      summary: 'UNVALIDATED_IDEA_MUST_NOT_LEAK',
      detail: 'Raw unacknowledged dream hypothesis.',
      evidenceRefs: [REF_HEX],
    })
    store.recordIdea({
      id: 'idea-rejected',
      runId: 'run-seed',
      createdAt: now - 7_000,
      dayKey,
      summary: 'REJECTED_IDEA_MUST_NOT_LEAK',
      detail: 'Explicitly rejected by owner.',
      evidenceRefs: [REF_HEX],
    })
    store.completeDream('run-seed', now - 5_000, 3)
    store.close()

    await ctx.plugin(AssistantDreamingService, {
      enabled: true,
      scope: dreamScope,
      databasePath: dreamDbPath,
      provider: 'test-provider',
      model: 'test-model',
      budgetId: 'dream-budget',
      budgetAmount: 1,
    })

    // Owner explicitly acknowledges + validates only `idea-validated`, and rejects `idea-rejected`.
    ctx.assistantDreaming.acknowledgeIdea({ ideaId: 'idea-validated', principalId: PRINCIPAL, note: 'worth checking' })
    ctx.assistantDreaming.transitionIdea({ ideaId: 'idea-validated', transition: 'validate', principalId: PRINCIPAL })
    ctx.assistantDreaming.transitionIdea({ ideaId: 'idea-rejected', transition: 'reject', principalId: PRINCIPAL })

    await ctx.plugin(AssistantGrowthDriverService, {
      enabled: true,
      intervalMs: 0,
      scope: dreamScope,
      provider: 'test-provider',
      model: 'test-model',
      budgetId: 'growth-budget',
      budgetAmount: 1,
      dreamingIdeas: { enabled: true, maxIdeasPerWake: 2 },
    })

    const growth = ctx.get('assistantGrowthDriver')!
    await growth.wake('manual')

    expect(adapter.messageTranscripts).toHaveLength(1)
    const transcript = adapter.messageTranscripts[0]!
    expect(transcript).toContain('Owner-validated dreaming ideas (bounded advisory hypotheses only)')
    expect(transcript).toContain('VALIDATED_IDEA_EXTRACT_CSV_HELPER')
    expect(transcript).not.toContain('UNVALIDATED_IDEA_MUST_NOT_LEAK')
    expect(transcript).not.toContain('REJECTED_IDEA_MUST_NOT_LEAK')
    // Frozen growth tool surface only — no duplicate goal-loop tools added.
    expect(adapter.toolNames[0]).toEqual([
      'growth_list_owner_goals',
      'growth_list_skills',
      'growth_propose_skill_candidate',
      'growth_read_verified_workflow',
    ])
    expect(growth.health()).toMatchObject({
      outcome: 'ran',
      dreamingIntake: {
        enabled: true,
        considered: 1,
        ingested: 1,
        rejectedUnvalidated: 0,
        ideaIds: ['idea-validated'],
      },
    })

    // Finite budget exhaustion still blocks subsequent dreaming-intake wakes without bypassing policy.
    await growth.wake('manual')
    expect(adapter.messageTranscripts).toHaveLength(1)
    expect(growth.health()).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringMatching(/^budget:/u),
      dreamingIntake: {
        enabled: false,
        considered: 0,
        ingested: 0,
        rejectedUnvalidated: 0,
        ideaIds: [],
      },
    })
  })
})
