import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  acceptanceDigest,
  goalDefinitionSituation,
} from '@dsh-enhanced/task-acceptance-contract'
import { AssistantPolicyService, setApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantEvolutionService,
  SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
  canonicalEvolutionScope,
} from '../src/service.ts'
import { EvolutionStore } from '../src/store.ts'
// Real goals advice ledger implementation (built sibling package, same
// convention as the repository-level recovery-strategy-learning integration).
import { GoalStrategyStore } from '../../assistant-goals/lib/strategy-store.js'
import { installQualityFixtures } from './quality-fixture.ts'

/**
 * Real two-ledger semantics for the supervised-growth analyst's
 * repeated-and-failing draft gate on `goal-definition:` adoption candidates.
 *
 * Both learning ledgers are the production SQLite implementations really
 * opened on their real files:
 *   - the goals GoalStrategyStore settles real advice runs, and
 *   - the production EvolutionStore.applyTaskLearningProjection path writes the
 *     trusted goal-outcome episodes (source='evaluation', trust='trusted',
 *     objective evidence — fixed by production code, not by test doubles),
 * and the real AssistantEvolutionService reads those same rows through its
 * production candidate query and kernel gate before minting a review token.
 * The goals store is offered through the same narrow optional-injection seam
 * the plugin uses in production.
 *
 * Only genuinely external *services* are replaced by local fakes: the
 * Delivery owner-route receipt and the policy/automation surroundings. Those
 * fakes are the engineering boundary, never learning evidence. Nothing here
 * adopts a rule, writes a permission row or bypasses owner approval: a minted
 * review token is at most the entry to the existing owner-gated proposal chain.
 */

const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const OWNER = 'lark/bot-1/tenant-a/ou_owner'
const OWNER_LINEAGE = Object.freeze({ principalRecordId: 'principal-owner', principalVersion: 4 })
const roots: string[] = []
const contexts = new Set<Context>()
const evolutionScopeKey = canonicalEvolutionScope(WORKSPACE, PRESET)

const intentBase = {
  parentRunId: 'run-analyst',
  parentSessionId: 'session-parent',
  definitionVersion: 1,
  kind: 'investigate' as const,
  provider: 'provider',
  model: 'model-id',
  maxChildren: 2,
  maxDurationMs: 300_000,
}
const completedChild = {
  stopReason: 'complete' as const,
  quiescent: true,
  diagnostics: { toolRejections: 0, output: 'accepted' as const },
}
const goalScope = Object.freeze({
  principalId: OWNER,
  principalRecordId: OWNER_LINEAGE.principalRecordId,
  principalVersion: OWNER_LINEAGE.principalVersion,
  workspace: WORKSPACE,
  preset: PRESET,
})

function analystAgent(occurrenceId: string): Agent {
  const id = SessionId(`analyst-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: WORKSPACE,
    agentPreset: PRESET,
    isSeeded: false,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
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
  agent.ctx.provide(
    'assistantAutomationExecution' as never,
    Object.freeze({
      mode: 'production',
      automationId: SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
      occurrenceId,
    }) as never,
  )
  return agent
}

interface Target {
  ctx: Context
  service: AssistantEvolutionService
  evolutionPath: string
  goals: GoalStrategyStore
  directEvolution: EvolutionStore
}

async function fixture(options: { provideGoals: boolean }): Promise<Target> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-evolution-analyst-draft-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    proposalMaintenanceIntervalMs: 0,
    rules: [
      {
        id: 'analyst-review',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace: WORKSPACE },
        actions: ['inspect'],
        resource: { kind: 'evolution', id: 'analyst-adoption' },
        context: { initiators: ['background'] },
      },
      {
        id: 'analyst-propose',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace: WORKSPACE },
        actions: ['propose'],
        resource: { kind: 'evolution', id: 'proposals' },
        context: { initiators: ['background'] },
      },
    ],
  })
  ctx.provide('assistantDelivery', {
    prepareAgentApproval: () => Object.freeze({
      routeVersion: 2,
      sourceId: 'dsh-enhanced-assistant-evolution',
      bindingId: 'analyst-owner-route',
      bindingVersion: 3,
      bindingGeneration: 2,
      workspace: WORKSPACE,
      principal: OWNER,
      principalRecordId: OWNER_LINEAGE.principalRecordId,
      principalVersion: OWNER_LINEAGE.principalVersion,
    }),
  } as never)

  const goals = new GoalStrategyStore(join(root, 'strategy.sqlite'))
  if (options.provideGoals) {
    ctx.provide('assistantGoals', {
      hostSummarizeAdviceByDefinition: (scope: typeof goalScope) =>
        goals.summarizeAdviceByDefinition(scope),
    } as never)
  }

  // Installs the real Evaluation service on its own SQLite file (the evolution
  // plugin requires the assistantEvaluation seam); the goal-outcome episodes
  // below are admitted through the production evolution projection directly.
  installQualityFixtures(ctx, join(root, 'evaluation.sqlite'))
  const evolutionPath = join(root, 'evolution.sqlite')
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    maxCandidates: 10,
    reconcileIntervalMs: 0,
  })

  // Second production-ledger connection to the SAME evolution file, used only
  // to admit authoritative task-learning projections (the production write
  // path), mirroring the repository-level recovery integration. WAL with a
  // busy timeout makes concurrent service reads safe. Every watermark handed
  // to this one scope must advance monotonically, so all seeding for a scope
  // goes through this connection with a shared increasing counter.
  const directEvolution = new EvolutionStore({ path: evolutionPath })

  return {
    ctx,
    service: ctx.assistantEvolution,
    evolutionPath,
    goals,
    directEvolution,
  }
}

/** Settle one real advice run through the production goals ledger. */
function settleAdvice(
  goals: GoalStrategyStore,
  input: {
    id: string
    goalId: string
    definitionDigest: string
    requestDigest: string
    outputDigest: string
    createdAt: number
    completedAt: number
  },
): void {
  goals.prepare({
    ...intentBase,
    id: input.id,
    goalId: input.goalId,
    definitionDigest: input.definitionDigest,
    scope: goalScope,
    requestDigest: input.requestDigest,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + 300_000,
  })
  goals.dispatch(input.id, 1, input.createdAt + 1)
  goals.bindChild(input.id, 2, `child-${input.id}`, input.createdAt + 2)
  goals.settle(
    input.id,
    3,
    {
      children: [{ sessionId: `child-${input.id}`, ...completedChild }],
      outcome: 'advice',
      outputDigest: input.outputDigest,
      quiescent: true,
      terminationReason: 'completed',
    },
    input.completedAt,
  )
}

/** Write trusted failed outcomes via the production task-learning projection. */
function seedTrustedFailures(
  store: EvolutionStore,
  input: {
    situation: string
    count: number
    subjectKind?: 'automation-run' | 'goal-outcome'
    startIndex?: number
  },
): void {
  const subjectKind = input.subjectKind ?? 'goal-outcome'
  const startIndex = input.startIndex ?? 1
  for (let offset = 0; offset < input.count; offset += 1) {
    const index = startIndex + offset
    const subjectRef = JSON.stringify(['evaluation-outcome', input.situation, index])
    const digest = createHash('sha256')
      .update(JSON.stringify({ scopeKey: evolutionScopeKey, subjectRef, situation: input.situation, outcome: 'failed' }))
      .digest('hex')
    store.applyTaskLearningProjection({
      scopeKey: evolutionScopeKey,
      scopeWatermark: index,
      subjectKind,
      subjectRef,
      version: 1,
      digest,
      disposition: 'upsert',
      situation: input.situation,
      outcome: 'failed',
      detail: `authoritative evaluation outcome ${index}`,
      evidenceRef: `evaluation:${input.situation}:${index}`,
      occurredAt: 1_000 + index,
    })
  }
}

/** 3 settled runs over 2 goal instances sharing one request digest => 2 repeated runs. */
function seedRepeatingAdvice(goals: GoalStrategyStore, definitionDigest: string): void {
  settleAdvice(goals, { id: 's1', goalId: 'goal-1', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
  settleAdvice(goals, { id: 's2', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
  settleAdvice(goals, { id: 's3', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })
}

function bindBackground(target: Target, agent: Agent): () => void {
  return target.ctx.assistantPolicy.bindInitiator(agent, 'background')
}

function tableCount(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath)
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  } finally {
    database.close()
  }
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('supervised growth analyst repeated-and-failing goal-definition draft gate', () => {
  test('mints a review token only when trusted failures and recurring real advice both hold', async () => {
    const target = await fixture({ provideGoals: true })
    try {
      const definitionDigest = acceptanceDigest({ objective: 'Draft the weekly sales summary from the CRM export.' })
      const situation = goalDefinitionSituation(definitionDigest)
      seedRepeatingAdvice(target.goals, definitionDigest)
      seedTrustedFailures(target.directEvolution, { situation, count: 4 })

      const agent = analystAgent('occ-goal-draft-hit')
      const unbind = bindBackground(target, agent)
      const review = target.service.reviewSupervisedGrowthAdoption(agent)

      expect(review.candidate).toMatchObject({
        contractVersion: 'supervised-growth-analyst/v1',
        situation,
        failures: 4,
        total: 4,
        evidenceTotal: 4,
        proposalExists: false,
      })
      expect(review.candidate?.reviewToken).toMatch(/^analyst-review-[0-9a-f-]{36}$/u)
      unbind()

      // A review draft is the ONLY side effect: no rule adopted, no proposal
      // card written, no permission widened. Owner adopt remains mandatory.
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_proposals')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(1)
    } finally {
      target.directEvolution.close()
      target.goals.close()
    }
  })

  test('withholds the draft when the same advice is not recurring across goal instances', async () => {
    const target = await fixture({ provideGoals: true })
    try {
      const situation = goalDefinitionSituation(
        acceptanceDigest({ objective: 'An objective whose advice never repeats.' }),
      )
      const definitionDigest = situation.slice('goal-definition:'.length)
      // 3 runs, but every request digest is distinct => repeatedAdviceRuns 0.
      for (const [index, request] of ['1', '2', '3'].entries()) {
        settleAdvice(target.goals, {
          id: `s${index}`,
          goalId: `goal-${index}`,
          definitionDigest,
          requestDigest: request.repeat(64),
          outputDigest: 'c'.repeat(64),
          createdAt: index + 1,
          completedAt: (index + 1) * 10,
        })
      }
      seedTrustedFailures(target.directEvolution, { situation, count: 4 })

      const agent = analystAgent('occ-goal-draft-nonrepeating')
      const unbind = bindBackground(target, agent)
      expect(target.service.reviewSupervisedGrowthAdoption(agent))
        .toEqual(Object.freeze({ contractVersion: 'supervised-growth-analyst/v1' }))
      unbind()
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(0)
    } finally {
      target.directEvolution.close()
      target.goals.close()
    }
  })

  test('fails closed for goal-definition drafts when the goals seam is absent, while non-goal candidates pass', async () => {
    const target = await fixture({ provideGoals: false })
    try {
      const goalSituation = goalDefinitionSituation(
        acceptanceDigest({ objective: 'Needs goals advice evidence that is unavailable.' }),
      )
      // Both a goal-definition and a legacy automation candidate are eligible
      // in the SAME scope. Watermarks advance through the one shared
      // connection (goal outcomes 1..4, automation runs 5..8).
      seedTrustedFailures(target.directEvolution, { situation: goalSituation, count: 4 })
      const automationSituation = 'automation:weekly-report'
      seedTrustedFailures(target.directEvolution, {
        situation: automationSituation,
        count: 4,
        subjectKind: 'automation-run',
        startIndex: 5,
      })

      const agent = analystAgent('occ-goal-draft-no-goals')
      const unbind = bindBackground(target, agent)
      // With the goals seam absent the gate removes the goal-definition
      // candidate but leaves the legacy automation candidate: narrowing, not
      // blanket suppression.
      const review = target.service.reviewSupervisedGrowthAdoption(agent)
      expect(review.candidate?.situation).toBe(automationSituation)
      expect(review.candidate?.failures).toBe(4)
      expect(review.candidate?.total).toBe(4)
      expect(review.candidate?.reviewToken).toMatch(/^analyst-review-[0-9a-f-]{36}$/u)
      unbind()
    } finally {
      target.directEvolution.close()
      target.goals.close()
    }
  })

  test('withholds the draft when trusted episodes fall below the candidate sample floor', async () => {
    const target = await fixture({ provideGoals: true })
    try {
      const situation = goalDefinitionSituation(
        acceptanceDigest({ objective: 'Too little authoritative evidence to draft anything.' }),
      )
      seedRepeatingAdvice(target.goals, situation.slice('goal-definition:'.length))
      // Repeating advice is real, but only two trusted outcomes exist: below
      // both the analyst minSample (4) and the kernel trusted floor (3).
      seedTrustedFailures(target.directEvolution, { situation, count: 2 })

      const agent = analystAgent('occ-goal-draft-too-few')
      const unbind = bindBackground(target, agent)
      expect(target.service.reviewSupervisedGrowthAdoption(agent))
        .toEqual(Object.freeze({ contractVersion: 'supervised-growth-analyst/v1' }))
      unbind()
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(0)
    } finally {
      target.directEvolution.close()
      target.goals.close()
    }
  })

  test('fails closed when advice repetition lives under a different owner principal lineage', async () => {
    const target = await fixture({ provideGoals: true })
    try {
      const definitionDigest = acceptanceDigest({ objective: 'Advice repeated for a different owner identity.' })
      const situation = goalDefinitionSituation(definitionDigest)
      // Settle advice under a foreign scope; the analyst dispatch routes the
      // query at the OWNER lineage, which must observe no repetition.
      const foreignScope = Object.freeze({
        principalId: 'lark/bot-1/tenant-b/ou_someone_else',
        principalRecordId: 'principal-other',
        principalVersion: 9,
        workspace: '/work/beta',
        preset: 'secondary',
      })
      for (const [index, id] of ['s1', 's2', 's3'].entries()) {
        target.goals.prepare({
          ...intentBase,
          id: `foreign-${id}`,
          goalId: `goal-${index}`,
          definitionDigest,
          scope: foreignScope,
          requestDigest: '1'.repeat(64),
          createdAt: index + 1,
          expiresAt: index + 300_001,
        })
        target.goals.dispatch(`foreign-${id}`, 1, index + 2)
        target.goals.bindChild(`foreign-${id}`, 2, `child-foreign-${id}`, index + 3)
        target.goals.settle(
          `foreign-${id}`,
          3,
          {
            children: [{
              sessionId: `child-foreign-${id}`,
              ...completedChild,
            }],
            outcome: 'advice',
            outputDigest: 'c'.repeat(64),
            quiescent: true,
            terminationReason: 'completed',
          },
          (index + 1) * 10,
        )
      }
      seedTrustedFailures(target.directEvolution, { situation, count: 4 })

      const agent = analystAgent('occ-goal-draft-foreign-lineage')
      const unbind = bindBackground(target, agent)
      expect(target.service.reviewSupervisedGrowthAdoption(agent))
        .toEqual(Object.freeze({ contractVersion: 'supervised-growth-analyst/v1' }))
      unbind()
    } finally {
      target.directEvolution.close()
      target.goals.close()
    }
  })
})
