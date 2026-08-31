import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  AssistantPolicyService,
  setApprovalReviewer,
  type ApprovalDispatchRoute,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantEvolutionError,
  AssistantEvolutionService,
  SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
} from '../src/service.ts'
import { evolutionSchemaVersion, openEvolutionDatabase } from '../src/sqlite.ts'
import {
  installQualityFixtures,
  projectTrustedOutcome,
  type FakeAutomationQualityResolver,
} from './quality-fixture.ts'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'

const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const OWNER = 'lark/bot-1/tenant-a/ou_owner'
const roots: string[] = []
const contexts = new Set<Context>()

interface Fixture {
  ctx: Context
  service: AssistantEvolutionService
  evaluation: AssistantEvaluationService
  qualityResolver: FakeAutomationQualityResolver
  evolutionPath: string
}

function analystAgent(options: {
  id?: string
  mode?: 'preview' | 'production'
  automationId?: string
  occurrenceId?: string
  execution?: boolean
  frozen?: boolean
} = {}): Agent {
  const id = SessionId(options.id ?? `analyst-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: WORKSPACE,
    agentPreset: PRESET,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
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
  if (options.execution !== false) {
    const value = {
      mode: options.mode ?? 'production',
      automationId: options.automationId ?? SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
      occurrenceId: options.occurrenceId ?? `occ-${id}`,
    }
    agent.ctx.provide(
      'assistantAutomationExecution' as never,
      (options.frozen ?? true ? Object.freeze(value) : value) as never,
    )
  }
  return agent
}

async function fixture(options: { route?: boolean; root?: string } = {}): Promise<Fixture> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'assistant-evolution-analyst-'))
  if (options.root === undefined) roots.push(root)
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
  if (options.route !== false) {
    const route: ApprovalDispatchRoute = {
      routeVersion: 2,
      sourceId: 'dsh-enhanced-assistant-evolution',
      bindingId: 'analyst-owner-route',
      bindingVersion: 3,
      bindingGeneration: 2,
      workspace: WORKSPACE,
      principal: OWNER,
      principalRecordId: 'principal-owner',
      principalVersion: 4,
    }
    ctx.provide('assistantDelivery', { prepareAgentApproval: () => route } as never)
  }
  const quality = installQualityFixtures(ctx, join(root, 'evaluation.sqlite'))
  const evolutionPath = join(root, 'evolution.sqlite')
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    maxCandidates: 10,
    reconcileIntervalMs: 0,
  })
  return { ctx, service: ctx.assistantEvolution, evolutionPath, ...quality }
}

async function seed(target: Fixture, situation: string, count = 4): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await projectTrustedOutcome({
      ...target,
      key: `${situation}:${index}`,
      situation,
      outcome: 'failed',
      workspace: WORKSPACE,
      preset: PRESET,
      occurredAt: 1_000 + index,
    })
  }
}

function bindBackground(target: Fixture, agent: Agent): () => void {
  return target.ctx.assistantPolicy.bindInitiator(agent, 'background')
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('supervised growth analyst', () => {
  test('returns one deterministic adopt candidate with a durable opaque evidence token', async () => {
    const target = await fixture()
    await seed(target, 'zeta-report')
    await seed(target, 'alpha-report')
    const agent = analystAgent({ occurrenceId: 'occ-review-one' })
    const unbind = bindBackground(target, agent)

    const first = target.service.reviewSupervisedGrowthAdoption(agent)
    const replay = target.service.reviewSupervisedGrowthAdoption(agent)

    expect(first.candidate).toMatchObject({
      contractVersion: 'supervised-growth-analyst/v1',
      situation: 'automation:alpha-report',
      failures: 4,
      total: 4,
      evidenceTotal: 4,
      evidenceWindow: 10,
      proposalExists: false,
    })
    expect(first.candidate?.reviewToken).toMatch(/^analyst-review-[0-9a-f-]{36}$/u)
    expect(first.candidate?.reviewToken).not.toContain(first.candidate!.evidenceDigest)
    expect(first.candidate?.sampleEpisodeIds).toHaveLength(4)
    expect(replay).toEqual(first)
    unbind()
  })

  test.each([
    ['foreground', analystAgent({ execution: false })],
    ['preview', analystAgent({ mode: 'preview' })],
    ['other automation', analystAgent({ automationId: 'heartbeat:other' })],
    ['mutable context', analystAgent({ frozen: false })],
  ])('fails closed for %s execution', async (_label, agent) => {
    const target = await fixture()
    await seed(target, 'weekly-report')
    const unbind = bindBackground(target, agent)
    expect(() => target.service.reviewSupervisedGrowthAdoption(agent)).toThrow(AssistantEvolutionError)
    unbind()
  })

  test('fails closed before minting a review when no owner route is available', async () => {
    const target = await fixture({ route: false })
    await seed(target, 'weekly-report')
    const agent = analystAgent({ occurrenceId: 'occ-no-route' })
    const unbind = bindBackground(target, agent)
    expect(() => target.service.reviewSupervisedGrowthAdoption(agent)).toThrow(/approval route/u)
    const database = new DatabaseSync(target.evolutionPath)
    expect((database.prepare('SELECT COUNT(*) AS count FROM evolution_supervised_analyst_reviews')
      .get() as { count: number }).count).toBe(0)
    database.close()
    unbind()
  })

  test('uses one durable evidence identity and preserves the first guidance wording', async () => {
    const target = await fixture()
    await seed(target, 'weekly-report')
    const firstAgent = analystAgent({ occurrenceId: 'occ-first' })
    const unbindFirst = bindBackground(target, firstAgent)
    const firstReview = target.service.reviewSupervisedGrowthAdoption(firstAgent)
    const first = target.service.proposeSupervisedGrowthAdoption(firstAgent, {
      reviewToken: firstReview.candidate!.reviewToken,
      guidance: 'Draft the report one day early.',
    })
    const replay = target.service.proposeSupervisedGrowthAdoption(firstAgent, {
      reviewToken: firstReview.candidate!.reviewToken,
      guidance: 'This later wording must lose.',
    })
    unbindFirst()

    const secondAgent = analystAgent({ occurrenceId: 'occ-second' })
    const unbindSecond = bindBackground(target, secondAgent)
    const secondReview = target.service.reviewSupervisedGrowthAdoption(secondAgent)
    const joined = target.service.proposeSupervisedGrowthAdoption(secondAgent, {
      reviewToken: secondReview.candidate!.reviewToken,
      guidance: 'A concurrent analyst also loses.',
    })

    expect(secondReview.candidate?.proposalExists).toBe(true)
    expect(replay.proposalId).toBe(first.proposalId)
    expect(joined.proposalId).toBe(first.proposalId)
    expect(replay.replayed).toBe(true)
    expect(joined.replayed).toBe(true)
    const database = new DatabaseSync(target.evolutionPath)
    const rows = database.prepare(`
      SELECT idempotency_key, mutation_json FROM evolution_proposals
      WHERE idempotency_key LIKE 'evolution-analyst:%'
    `).all() as unknown as { idempotency_key: string; mutation_json: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.mutation_json)).toMatchObject({
      input: { guidance: 'Draft the report one day early.' },
    })
    expect(rows[0]!.idempotency_key).not.toContain('occ-first')
    database.close()
    unbindSecond()
  })

  test('joins the same evidence proposal after a full service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evolution-analyst-restart-'))
    roots.push(root)
    const first = await fixture({ root })
    await seed(first, 'restart-report')
    const firstAgent = analystAgent({ occurrenceId: 'occ-before-restart' })
    const unbindFirst = bindBackground(first, firstAgent)
    const firstReview = first.service.reviewSupervisedGrowthAdoption(firstAgent)
    const winner = first.service.proposeSupervisedGrowthAdoption(firstAgent, {
      reviewToken: firstReview.candidate!.reviewToken,
      guidance: 'This durable wording wins.',
    })
    unbindFirst()
    contexts.delete(first.ctx)
    await first.ctx.fiber.restart()

    const restarted = await fixture({ root })
    const restartedAgent = analystAgent({ occurrenceId: 'occ-after-restart' })
    const unbindRestarted = bindBackground(restarted, restartedAgent)
    const restartedReview = restarted.service.reviewSupervisedGrowthAdoption(restartedAgent)
    const replay = restarted.service.proposeSupervisedGrowthAdoption(restartedAgent, {
      reviewToken: restartedReview.candidate!.reviewToken,
      guidance: 'Restarted wording must not replace the winner.',
    })

    expect(restartedReview.candidate?.proposalExists).toBe(true)
    expect(replay).toMatchObject({ proposalId: winner.proposalId, replayed: true })
    const database = new DatabaseSync(restarted.evolutionPath)
    const proposals = database.prepare(`
      SELECT mutation_json FROM evolution_proposals
      WHERE idempotency_key LIKE 'evolution-analyst:%'
    `).all() as unknown as { mutation_json: string }[]
    expect(proposals).toHaveLength(1)
    expect(JSON.parse(proposals[0]!.mutation_json)).toMatchObject({
      input: { guidance: 'This durable wording wins.' },
    })
    database.close()
    unbindRestarted()
  })

  test('revalidates the complete evidence window and rejects a stale token', async () => {
    const target = await fixture()
    await seed(target, 'weekly-report')
    const agent = analystAgent({ occurrenceId: 'occ-stale' })
    const unbind = bindBackground(target, agent)
    const reviewed = target.service.reviewSupervisedGrowthAdoption(agent)
    await projectTrustedOutcome({
      ...target,
      key: 'weekly-report:newer',
      situation: 'weekly-report',
      outcome: 'failed',
      workspace: WORKSPACE,
      preset: PRESET,
      occurredAt: 2_000,
    })

    expect(() => target.service.proposeSupervisedGrowthAdoption(agent, {
      reviewToken: reviewed.candidate!.reviewToken,
      guidance: 'This proposal was built from stale evidence.',
    })).toThrow(/evidence/u)
    const database = new DatabaseSync(target.evolutionPath)
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM evolution_proposals
      WHERE idempotency_key LIKE 'evolution-analyst:%'
    `).get() as { count: number }).count).toBe(0)
    database.close()
    unbind()
  })

  test('migrates v9 databases with an empty durable analyst ledger', () => {
    const path = join('/tmp', `assistant-evolution-v9-${Math.random()}.sqlite`)
    roots.push(path)
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '9');
      CREATE TABLE evolution_proposals (
        id TEXT PRIMARY KEY, policy_proposal_id TEXT UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL, principal TEXT NOT NULL, scope_key TEXT NOT NULL,
        mutation_hash TEXT NOT NULL, mutation_json TEXT NOT NULL, creation_intent_json TEXT,
        settlement_expectation_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','conflicted')),
        expires_at INTEGER NOT NULL, result_rule_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE evolution_task_learning_state (
        scope_key TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_ref TEXT NOT NULL,
        version INTEGER NOT NULL, digest TEXT NOT NULL, disposition TEXT NOT NULL,
        situation TEXT NOT NULL, episode_id TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key, subject_kind, subject_ref)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE evolution_task_learning_revisions (
        scope_key TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_ref TEXT NOT NULL,
        version INTEGER NOT NULL, digest TEXT NOT NULL, disposition TEXT NOT NULL,
        situation TEXT NOT NULL, episode_id TEXT, applied_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key, subject_kind, subject_ref, version)
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 9;
    `)
    database.close()

    const migrated = openEvolutionDatabase(path)
    expect(evolutionSchemaVersion).toBe(12)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12)
    expect((migrated.prepare('SELECT COUNT(*) AS count FROM evolution_supervised_analyst_reviews')
      .get() as { count: number }).count).toBe(0)
    migrated.close()
  })
})
