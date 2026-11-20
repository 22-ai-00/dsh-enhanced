import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseBenchmarkPlan, type BenchmarkPlan } from '@dsh-enhanced/assistant-evaluation/benchmark'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAssociationCandidateInput,
  computeAssociationOwnerScopeKey,
  readAssociationCandidates,
} from '../src/association-intake.ts'
import { runGrowthAgent } from '../src/growth-agent.ts'
import { AssistantGrowthDriverService, normalizeConfig, type GrowthAuthority } from '../src/index.ts'

const PRINCIPAL = 'owner-1'
const RECORD_ID = 'record-owner-1'
const OWNER_ROUTE = 'owner-route'
const PRESET = 'primary'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const SIG_HEX = sha('cluster-signature-1')
const DREAM_REF_HEX = 'a'.repeat(64)

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
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reviewed association leads' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ProposeSkillFromLeadAdapter extends LlmAdapter {
  readonly messageTranscripts: string[] = []
  private step = 0

  override async resolveModel(provider: string, model: string) {
    return {
      ...await super.resolveModel(provider, model),
      reasoning: { efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }] },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.messageTranscripts.push(JSON.stringify(options.messages))
    this.step += 1
    if (this.step === 1) {
      const id = ToolCallId('call-propose-1')
      const argumentsText = JSON.stringify({
        name: 'assoc-verified-skill',
        description: 'Candidate proposed from association goalLocators.',
        success_locators: [
          { session_id: 'sess-assoc-1', goal_id: 'goal-assoc-1' },
          { session_id: 'sess-assoc-2', goal_id: 'goal-assoc-2' },
          { session_id: 'sess-assoc-3', goal_id: 'goal-assoc-3' },
        ],
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'growth_propose_skill_candidate', argumentsDelta: argumentsText }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id,
          name: 'growth_propose_skill_candidate',
          arguments: argumentsText,
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'completed goal verification check' } }
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

function activeAuthority(workspace = join(tmpdir(), 'assoc-intake-test')): GrowthAuthority {
  return {
    id: 'growth-auth-assoc-1',
    scope: ownerScope(workspace),
    ownerRouteId: OWNER_ROUTE,
    expiresAt: Date.now() + 60_000,
    assertCurrent: () => {},
  }
}

function makeRawCandidate(
  id: string,
  ownerScopeKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    candidateId: id,
    ownerScopeKey,
    clusterId: `cluster-${id}`,
    signatureDigest: SIG_HEX,
    name: `skill-${id}`,
    description: `Derived from verified non-holdout episodes for ${id}.`,
    toolSequence: ['read_file', 'run_command'],
    sharedEntities: ['deploy_pipeline', 'csv_parser'],
    memberTaskIds: ['task-1', 'task-2', 'task-3'],
    goalLocators: [
      { sessionId: 'sess-assoc-1', goalId: 'goal-assoc-1' },
      { sessionId: 'sess-assoc-2', goalId: 'goal-assoc-2' },
    ],
    similarity: 0.87,
    wp04Verified: true,
    status: 'pending',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  }
}

function makeBenchmarkPlan(split: 'development' | 'holdout', id = 'assoc-plan'): BenchmarkPlan {
  const versions = Object.fromEntries(['model', 'prompt', 'skills', 'tools', 'policy', 'runtime'].map(key => [key, sha(key)]))
  const features = { memory: false, planning: false, review: false, growth: false }
  return parseBenchmarkPlan({
    schemaVersion: 1,
    id,
    dataset: { id: 'dsh-assoc-input', version: '1', digest: sha('assoc-input'), split },
    comparison: 'capability',
    cases: [{ id: 'case-1', domain: 'code', inputDigest: sha('input'), acceptanceDigest: sha('acceptance') }],
    variants: [
      { id: 'baseline', role: 'baseline', versions: { ...versions }, features: { ...features } },
      { id: 'candidate', role: 'candidate', versions: { ...versions }, features: { ...features } },
    ],
    budget: { durationMs: 1000, inputTokens: 0, outputTokens: 0, costUsdMicros: 0, toolCalls: 1 },
    repeats: 2,
    seed: 1,
  })
}

describe('associationCandidates config validation', () => {
  it('defaults off and enforces enabled/scope invariants and bounds', () => {
    expect(normalizeConfig().associationCandidates).toEqual({ enabled: false, maxCandidatesPerWake: 3 })
    expect(() => normalizeConfig({ associationCandidates: { enabled: true } })).toThrow(
      /associationCandidates\.enabled requires the driver itself/u,
    )
    expect(() => normalizeConfig({ enabled: true, associationCandidates: { enabled: true } })).toThrow(
      /explicit owner scope/u,
    )
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: join(tmpdir(), 'ws'), preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      associationCandidates: { enabled: true, maxCandidatesPerWake: 0 },
    })).toThrow()
    expect(() => normalizeConfig({
      enabled: true,
      scope: { workspace: join(tmpdir(), 'ws'), preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      associationCandidates: { enabled: true, maxCandidatesPerWake: 11 },
    })).toThrow()
    const valid = normalizeConfig({
      enabled: true,
      scope: { workspace: join(tmpdir(), 'ws'), preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      associationCandidates: { enabled: true, maxCandidatesPerWake: 4 },
    })
    expect(valid.associationCandidates).toEqual({ enabled: true, maxCandidatesPerWake: 4 })
  })
})

describe('association-intake fail-closed filtering', () => {
  it('skips gracefully when assistantAssociation is absent or disabled', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const auth = activeAuthority()
    expect(readAssociationCandidates(ctx, auth, 3)).toEqual({
      candidates: [],
      summary: { enabled: false, considered: 0, ingested: 0, rejectedUnverified: 0, candidateIds: [] },
    })

    ctx.provide('assistantAssociation' as never, {
      enabled: false,
      listSkillCandidates: () => [makeRawCandidate('ignored', computeAssociationOwnerScopeKey(auth.scope))],
    } as never)
    expect(readAssociationCandidates(ctx, auth, 3)).toEqual({
      candidates: [],
      summary: { enabled: false, considered: 0, ingested: 0, rejectedUnverified: 0, candidateIds: [] },
    })

    const ctxThrow = new Context()
    contexts.push(ctxThrow)
    ctxThrow.provide('assistantAssociation' as never, {
      enabled: true,
      listSkillCandidates: () => {
        const err = new Error('assistant-association is disabled') as Error & { code: string }
        err.code = 'disabled'
        throw err
      },
    } as never)
    expect(readAssociationCandidates(ctxThrow, auth, 3)).toEqual({
      candidates: [],
      summary: { enabled: false, considered: 0, ingested: 0, rejectedUnverified: 0, candidateIds: [] },
    })
  })

  it('reads wp04Verified pending candidates for ownerScopeKey and ignores unverified, non-pending, cross-scope, and malformed items', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const auth = activeAuthority()
    const expectedKey = computeAssociationOwnerScopeKey(auth.scope)
    const listSpy = vi.fn(() => [
      makeRawCandidate('c-unverified', expectedKey, { wp04Verified: false }),
      makeRawCandidate('c-staged', expectedKey, { status: 'staged' }),
      makeRawCandidate('c-dismissed', expectedKey, { status: 'dismissed' }),
      makeRawCandidate('c-cross-owner', sha('other-owner-scope')),
      makeRawCandidate('c-bad-sig', expectedKey, { signatureDigest: 'not-hex' }),
      makeRawCandidate('c-empty-tools', expectedKey, { toolSequence: [] }),
      makeRawCandidate('c-ok-1', expectedKey),
      makeRawCandidate('c-ok-2', expectedKey, { goalLocators: [] }),
      makeRawCandidate('c-ok-3', expectedKey),
    ])

    ctx.provide('assistantAssociation' as never, {
      enabled: true,
      listSkillCandidates: listSpy,
    } as never)

    const result = readAssociationCandidates(ctx, auth, 2)
    expect(listSpy).toHaveBeenCalledWith(expectedKey, { status: 'pending', limit: 20 })
    expect(result.candidates.map(c => c.candidateId)).toEqual(['c-ok-1', 'c-ok-2'])
    expect(result.candidates[0]!.goalLocators).toEqual([
      { sessionId: 'sess-assoc-1', goalId: 'goal-assoc-1' },
      { sessionId: 'sess-assoc-2', goalId: 'goal-assoc-2' },
    ])
    expect(result.summary).toEqual({
      enabled: true,
      considered: 8,
      ingested: 2,
      rejectedUnverified: 6,
      candidateIds: ['c-ok-1', 'c-ok-2'],
    })
  })

  it('rejects unverified direct inputs and authority expiration cleanly', async () => {
    const auth = activeAuthority()
    const scopeKey = computeAssociationOwnerScopeKey(auth.scope)
    expect(() => assertAssociationCandidateInput(makeRawCandidate('bad-wp04', scopeKey, { wp04Verified: false }))).toThrow(
      /refusing unverified association candidate/u,
    )
    expect(() => assertAssociationCandidateInput(makeRawCandidate('bad-status', scopeKey, { status: 'staged' }))).toThrow(
      /refusing non-pending association candidate/u,
    )

    const ctx = new Context()
    contexts.push(ctx)
    const unverified = {
      ...makeRawCandidate('sneaky-unverified', scopeKey),
      status: 'pending' as const,
      wp04Verified: false as unknown as true,
      digest: SIG_HEX,
    }
    await expect(runGrowthAgent(ctx, {
      wakeId: 'w-assoc-fail',
      authority: auth,
      config: normalizeConfig({
        enabled: true,
        scope: { workspace: auth.scope.workspace, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      }),
      model: { provider: 'test-provider', model: 'test-model' },
      goals: { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: async () => { throw new Error('unused') } },
      skills: {
        inspectOwnerActiveSkills: () => [],
        inspectOwnerSkillCandidates: () => [],
        stageOwnerVerifiedSuccessCandidate: () => { throw new Error('unused') },
      },
      associationCandidates: [unverified],
    })).rejects.toThrow(/refusing unverified association candidate/u)

    const expired: GrowthAuthority = {
      ...auth,
      assertCurrent: () => { throw new Error('authority expired') },
    }
    expect(() => readAssociationCandidates(ctx, expired, 3)).toThrow(/authority expired/u)
  })
})

describe('WP04 and Goal verification preservation', () => {
  it('rejects holdout benchmarkPlan via assertCandidateGenerationOrigin even when valid associationCandidates are present', async () => {
    const auth = activeAuthority()
    const scopeKey = computeAssociationOwnerScopeKey(auth.scope)
    const validCandidate = assertAssociationCandidateInput(makeRawCandidate('c-valid', scopeKey))
    const stageOwnerVerifiedSuccessCandidate = vi.fn()
    const inspectOwnerGoals = vi.fn()

    await expect(runGrowthAgent({} as never, {
      wakeId: 'w-holdout-guard',
      authority: auth,
      config: normalizeConfig({
        enabled: true,
        scope: { workspace: auth.scope.workspace, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      }),
      model: { provider: 'test-provider', model: 'test-model' },
      goals: { inspectOwnerGoals, inspectOwnerVerifiedWorkflowSource: vi.fn() } as never,
      skills: {
        inspectOwnerActiveSkills: vi.fn(),
        inspectOwnerSkillCandidates: vi.fn(),
        stageOwnerVerifiedSuccessCandidate,
      } as never,
      benchmarkPlan: makeBenchmarkPlan('holdout'),
      associationCandidates: [validCandidate],
    })).rejects.toThrow(/holdout data must never be used for candidate generation/u)

    expect(stageOwnerVerifiedSuccessCandidate).not.toHaveBeenCalled()
    expect(inspectOwnerGoals).not.toHaveBeenCalled()
  })

  it('rejects associationCandidates sharing a task-feedback wake', async () => {
    const auth = activeAuthority()
    const scopeKey = computeAssociationOwnerScopeKey(auth.scope)
    const validCandidate = assertAssociationCandidateInput(makeRawCandidate('c-valid-fb', scopeKey))

    await expect(runGrowthAgent({} as never, {
      wakeId: 'w-feedback-guard',
      authority: auth,
      config: normalizeConfig({
        enabled: true,
        scope: { workspace: auth.scope.workspace, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
      }),
      model: { provider: 'test-provider', model: 'test-model' },
      goals: { inspectOwnerGoals: vi.fn(), inspectOwnerVerifiedWorkflowSource: vi.fn() } as never,
      skills: {
        inspectOwnerActiveSkills: vi.fn(),
        inspectOwnerSkillCandidates: vi.fn(),
        stageOwnerVerifiedSuccessCandidate: vi.fn(),
      } as never,
      feedback: { protocol: 'assistant-delivery/owner-foreground-learning/v1' } as never,
      associationCandidates: [validCandidate],
    })).rejects.toThrow(/association candidates cannot share a task-feedback wake/u)
  })

  it('surfaces associationCandidates alongside validatedDreamIdeas without bypassing Goal verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'growth-assoc-int-'))
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
    ctx.provide('assistantGoals' as never, {
      inspectOwnerGoals: () => [],
      inspectOwnerVerifiedWorkflowSource: async () => { throw new Error('no goals expected') },
    } as never)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [
        { id: 'growth-budget', metric: 'automation-runs', limit: 2, periodMs: 60_000, scope: 'workspace' },
      ],
      rules: [
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

    const scopeCfg = { workspace: root, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE }
    const expectedKey = computeAssociationOwnerScopeKey(ownerScope(root))

    ctx.provide('assistantDreaming' as never, {
      health: () => ({ enabled: true }),
      inspectValidatedIdeas: () => [{
        id: 'dream-idea-1',
        lane: 'lane-1',
        createdAt: 1_700_000_000_000,
        dayKey: '2026-11-20',
        state: 'validated',
        summary: 'DREAM_COEXIST_LEAD',
        detail: 'Dreaming advisory detail.',
        evidenceRefs: [DREAM_REF_HEX],
      }],
    } as never)

    ctx.provide('assistantAssociation' as never, {
      enabled: true,
      listSkillCandidates: () => [
        makeRawCandidate('assoc-unverified', expectedKey, {
          name: 'UNVERIFIED_ASSOC_MUST_NOT_LEAK',
          wp04Verified: false,
        }),
        makeRawCandidate('assoc-staged', expectedKey, {
          name: 'STAGED_ASSOC_MUST_NOT_LEAK',
          status: 'staged',
        }),
        makeRawCandidate('assoc-verified-1', expectedKey, {
          name: 'VERIFIED_ASSOC_CSV_PIPELINE',
          goalLocators: [
            { sessionId: 'sess-goal-10', goalId: 'goal-10' },
            { sessionId: 'sess-goal-11', goalId: 'goal-11' },
          ],
        }),
      ],
    } as never)

    await ctx.plugin(AssistantGrowthDriverService, {
      enabled: true,
      intervalMs: 0,
      scope: scopeCfg,
      provider: 'test-provider',
      model: 'test-model',
      budgetId: 'growth-budget',
      budgetAmount: 1,
      dreamingIdeas: { enabled: true, maxIdeasPerWake: 2 },
      associationCandidates: { enabled: true, maxCandidatesPerWake: 2 },
    })

    const growth = ctx.get('assistantGrowthDriver')!
    await growth.wake()

    expect(adapter.messageTranscripts).toHaveLength(1)
    const transcript = adapter.messageTranscripts[0]!
    expect(transcript).toContain('Owner-validated dreaming ideas (bounded advisory hypotheses only)')
    expect(transcript).toContain('DREAM_COEXIST_LEAD')
    expect(transcript).toContain('WP04-verified association skill candidate leads (bounded advisory hypotheses only)')
    expect(transcript).toContain('VERIFIED_ASSOC_CSV_PIPELINE')
    expect(transcript).toContain('sess-goal-10')
    expect(transcript).toContain('goal-10')
    expect(transcript).not.toContain('UNVERIFIED_ASSOC_MUST_NOT_LEAK')
    expect(transcript).not.toContain('STAGED_ASSOC_MUST_NOT_LEAK')

    expect(adapter.toolNames[0]).toEqual([
      'growth_list_owner_goals',
      'growth_list_skills',
      'growth_propose_skill_candidate',
      'growth_read_verified_workflow',
    ])
    expect(growth.health()).toMatchObject({
      outcome: 'ran',
      dreamingIntake: { enabled: true, ingested: 1, ideaIds: ['dream-idea-1'] },
      associationIntake: {
        enabled: true,
        considered: 3,
        ingested: 1,
        rejectedUnverified: 2,
        candidateIds: ['assoc-verified-1'],
      },
    })
  })

  it('skips association intake gracefully when assistantAssociation is absent and preserves Goal verification on proposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'growth-assoc-goal-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)

    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    ctx.provide('approval' as never, { config: { policy: 'ask' }, request: vi.fn(async () => 'allowed-once' as const) } as never)
    const adapter = new ProposeSkillFromLeadAdapter()
    ctx.llm.registerAdapter(['test-provider'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })

    const makeReceipt = (req: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => Object.freeze({
      receiptVersion: 2 as const,
      authorityId: req.authorityId,
      authorityHash: 'a'.repeat(64),
      principalId: req.principalId,
      principalRecordId: RECORD_ID,
      principalVersion: 1,
      workspace: req.workspace,
      agentPreset: req.agentPreset,
      bindingVersion: 1,
      generation: 1,
    })
    ctx.provide('assistantDelivery' as never, {
      validateOwnerRoute: makeReceipt,
      inspectOwnerRouteState: () => ({
        status: 'active',
        receipt: makeReceipt({ authorityId: OWNER_ROUTE, principalId: PRINCIPAL, workspace: root, agentPreset: PRESET }),
      }),
      inspectOwnerModelSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
      resolveOwnerRoute: () => ({ binding: { sessionId: 'owner-sess' } }),
      enqueueOwnerNotification: () => ({ id: 'notif-1' }),
    } as never)

    const verifySpy = vi.fn(async () => {
      throw new Error('goal is not owner-root succeeded')
    })
    ctx.provide('assistantGoals' as never, {
      inspectOwnerGoals: () => [],
      inspectOwnerVerifiedWorkflowSource: verifySpy,
    } as never)

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [
        { id: 'growth-budget', metric: 'automation-runs', limit: 2, periodMs: 60_000, scope: 'workspace' },
      ],
      rules: [
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

    const scopeCfg = { workspace: root, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE }
    await ctx.plugin(AssistantGrowthDriverService, {
      enabled: true,
      intervalMs: 0,
      scope: scopeCfg,
      provider: 'test-provider',
      model: 'test-model',
      budgetId: 'growth-budget',
      budgetAmount: 1,
      associationCandidates: { enabled: true, maxCandidatesPerWake: 2 },
    })

    const growth = ctx.get('assistantGrowthDriver')!
    await growth.wake()

    // Even when assistantAssociation is absent, wake succeeds cleanly with associationIntake disabled.
    expect(growth.health()).toMatchObject({
      outcome: 'ran',
      associationIntake: {
        enabled: false,
        considered: 0,
        ingested: 0,
        rejectedUnverified: 0,
        candidateIds: [],
      },
    })
    // Proposing a candidate still delegates to assistant-skills -> Goal verification and stages nothing on failure.
    expect(verifySpy).toHaveBeenCalled()
    const rawSkills = (ctx.assistantSkills as unknown as Record<symbol, typeof ctx.assistantSkills>)[Symbol.for('cordis.original')]
      ?? ctx.assistantSkills
    expect(rawSkills.inspectOwnerSkillCandidates(ownerScope(root))).toEqual([])
  })
})
