import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  acceptanceDigest,
  goalDefinitionSituation,
} from '@dsh-enhanced/task-acceptance-contract'
import { AssistantPolicyService, setApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type {
  AcceptedExecution,
  AcceptanceTask,
  TaskAcceptanceProducer,
  TaskAcceptanceRegistration,
} from '@dsh-enhanced/assistant-verifier'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantEvolutionService,
  SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
  canonicalEvolutionHostScope,
  canonicalEvolutionScope,
} from '../src/service.ts'
// Real goals advice ledger implementation (built sibling package, same
// convention as analyst-strategy-draft and the whole-goal Evaluation test).
import { GoalStrategyStore } from '../../assistant-goals/lib/strategy-store.js'
import { installQualityFixtures } from './quality-fixture.ts'

/**
 * End-to-end owner-gated self-evolution closure for `goal-definition:` rules
 * over the REAL verifier → Evaluation → Evolution trusted pipeline.
 *
 *   a real whole-goal verifier judges 4 goal-outcome assessments not-achieved
 *   (a document-citations criterion whose required text is absent — a purely
 *   local, network-free objective verdict) and appends them through the real
 *   Evaluation durable outbox,
 *     -> projectTrustedEvaluationTaskRevision + projectEvaluationOutcome deliver
 *        the SAME authoritative task revision into BOTH ledgers, so the
 *        Evolution writer fence watermark/digest matches Evaluation exactly,
 *   + recurring real goals advice over the same definition,
 *     -> supervised-growth analyst mints a review token,
 *     -> analyst proposes adoption (guidance wording only; no rule yet),
 *     -> the OWNER approves the policy proposal and reconciliation activates a
 *        `goal-definition:<digest>` rule,
 *     -> a LATER ordinary foreground goal session in the same owner scope is
 *        injected with that learned guidance on session start,
 *     -> one durable guidance exposure per session; a repeated session-start in
 *        the same session never injects twice.
 *
 * Every learning ledger is a production SQLite implementation on a real file:
 * GoalStrategyStore settles real advice, the real AssistantVerifierService
 * issues the objective receipt, the real AssistantEvaluationService projects
 * it, and the real AssistantEvolutionService reads those rows through its
 * production candidate gate, writer fence and foreground injection path. The
 * only engineering doubles are the delivery owner-route receipt and the
 * policy/automation surroundings — never learning evidence. Nothing
 * self-adopts: the rule exists solely after an explicit owner 'approved'
 * decision; the rejected control case proves the chain stays dark without it.
 */

const PRESET = 'primary'
const OWNER = 'lark/bot-1/tenant-a/ou_owner'
const OWNER_LINEAGE = Object.freeze({ principalRecordId: 'principal-owner', principalVersion: 4 })
const OBJECTIVE = 'Draft the weekly sales summary from the CRM export.'
const DEFINITION_DIGEST = acceptanceDigest({ objective: OBJECTIVE })
const SITUATION = goalDefinitionSituation(DEFINITION_DIGEST)
const GUIDANCE_TEXT = 'Confirm the CRM export column layout before drafting the weekly sales summary.'
const REQUIRED_TEXT = 'VERIFIED COMPLETE WEEKLY SALES SUMMARY'
const roots: string[] = []
const contexts = new Set<Context>()

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

/**
 * One object serves BOTH host seams the production services discover under
 * `assistantGoals`: the Evolution advice-summary seam
 * (`hostSummarizeAdviceByDefinition`) and the Verifier whole-goal acceptance
 * producer. A single registered object is what production wires too (the real
 * AssistantGoalsService implements both surfaces).
 */
class GoalOutcomeProducer implements TaskAcceptanceProducer {
  readonly generation = `goal-closure-test-goals:${crypto.randomUUID()}`
  registration: TaskAcceptanceRegistration | undefined
  proof: AcceptedExecution | null = null

  constructor(private readonly goals: GoalStrategyStore) {}

  hostSummarizeAdviceByDefinition(scope: Parameters<GoalStrategyStore['summarizeAdviceByDefinition']>[0]) {
    return this.goals.summarizeAdviceByDefinition(scope)
  }

  trustedAcceptanceProducerGeneration(): string { return this.generation }

  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration): () => void {
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }

  async inspectAcceptedExecution(): Promise<AcceptedExecution | null> { return this.proof }
}

/** A normal foreground goal session: no automation execution context, with a
 * real inbox and an inject() that records what the evolution plugin pushes. */
function foregroundSession(workspace: string, id: string): { agent: Agent; injections: UserMessage[] } {
  const sessionId = SessionId(`foreground-goal-${id}-${Math.random()}`)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd: workspace,
    agentPreset: PRESET,
    isSeeded: false,
  })
  const injections: UserMessage[] = []
  const agent: Agent = {
    id: sessionId,
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
    inject(message) { injections.push(message) },
  }
  return { agent, injections }
}

/** The background supervised-growth analyst, running in its production
 * automation execution context. Set `automationExecution:false` to build the
 * same policy-shaped agent WITHOUT the frozen production context, so the
 * service's second analyst gate can be proven to fail closed on its own. */
function analystAgent(
  workspace: string,
  occurrenceId: string,
  options: { automationExecution?: boolean } = {},
): Agent {
  const id = SessionId(`analyst-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: workspace,
    agentPreset: PRESET,
    isSeeded: false,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  // A background heartbeat agent can never ask an interactive user, so its
  // session carries the coherent full-access bundle the production automation
  // runtime creates (policy=never + reviewer=none + sandbox=danger-full-access).
  // Without all three, getApprovalReviewer conservatively resolves back to
  // 'user' and the tool pre-execute waterfall asks for approval instead of
  // reaching the per-tool execute policy the heartbeat relies on.
  const appendPermission = session.append as unknown as (type: string, data: unknown) => unknown
  appendPermission.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
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
  if (options.automationExecution !== false) {
    agent.ctx.provide(
      'assistantAutomationExecution' as never,
      Object.freeze({
        mode: 'production',
        automationId: SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
        occurrenceId,
      }) as never,
    )
  }
  return agent
}

interface Target {
  ctx: Context
  service: AssistantEvolutionService
  policy: AssistantPolicyService
  evolutionPath: string
  workspace: string
  goals: GoalStrategyStore
  producer: GoalOutcomeProducer
  verifier: AssistantVerifierService
  deliverFailedGoalOutcome: (assessmentId: string) => Promise<void>
}

async function fixture(): Promise<Target> {
  const workspace = await mkdtemp(join(tmpdir(), 'assistant-evolution-goal-closure-'))
  roots.push(workspace)
  const ctx = new Context()
  contexts.add(ctx)
  // The real tool runtime the production analyst heartbeat actually dispatches
  // through: evolution tools are registered by the Evolution plugin on this
  // runtime, and execute() enforces the per-tool `execute` policy below.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  // The document the goal produces deliberately OMITS the verifier's required
  // text, so the whole-goal objective is judged not-achieved (a real local
  // objective failure -> a 'failed' behavioural learning vote). quotes is
  // empty, so no network source is ever consulted.
  await writeFile(join(workspace, 'report.md'), 'incomplete draft without the required line\n')

  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(workspace, 'policy.sqlite'),
    proposalMaintenanceIntervalMs: 0,
    rules: [
      // Background analyst: inspect the adoption candidate and propose.
      {
        id: 'analyst-review',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['inspect'],
        resource: { kind: 'evolution', id: 'analyst-adoption' },
        context: { initiators: ['background'] },
      },
      {
        id: 'analyst-propose',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['propose'],
        resource: { kind: 'evolution', id: 'proposals' },
        context: { initiators: ['background'] },
      },
      // Per-tool execute grants mirroring the production analyst policy in
      // lark-channel supervised-growth-profile.ts: the heartbeat agent may
      // invoke exactly these two tools, and only under the background initiator.
      {
        id: 'analyst-tool-review',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['execute'],
        resource: { kind: 'tool', id: 'evolution_adoption_review' },
        context: { initiators: ['background'] },
      },
      {
        id: 'analyst-tool-propose',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['execute'],
        resource: { kind: 'tool', id: 'evolution_adoption_propose' },
        context: { initiators: ['background'] },
      },
      // Ordinary foreground goal sessions: the guidance snapshot authorize.
      {
        id: 'foreground-guidance-snapshot',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['append', 'inspect', 'snapshot'],
        resource: { kind: 'evolution', id: '*' },
        context: { initiators: ['foreground'] },
      },
    ],
  })
  const policy = ctx.assistantPolicy
  ctx.provide('assistantDelivery', {
    prepareAgentApproval: () => Object.freeze({
      routeVersion: 2,
      sourceId: 'dsh-enhanced-assistant-evolution',
      bindingId: 'analyst-owner-route',
      bindingVersion: 3,
      bindingGeneration: 2,
      workspace,
      principal: OWNER,
      principalRecordId: OWNER_LINEAGE.principalRecordId,
      principalVersion: OWNER_LINEAGE.principalVersion,
    }),
  } as never)

  const goals = new GoalStrategyStore(join(workspace, 'strategy.sqlite'))
  const producer = new GoalOutcomeProducer(goals)
  ctx.provide('assistantGoals', producer as never)

  // Real Evaluation service on its own SQLite file (the Evolution writer fence
  // reads this ledger's authoritative task-revision watermark).
  const { evaluation } = installQualityFixtures(ctx, join(workspace, 'evaluation.sqlite'))
  const evolutionPath = join(workspace, 'evolution.sqlite')
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    maxCandidates: 10,
    reconcileIntervalMs: 0,
  })

  // Real whole-goal verifier: acceptance required, one goal-outcome profile in
  // this exact owner scope, a single network-free document-citations criterion.
  const documentAuthority = Object.freeze({
    kind: 'document' as const,
    id: 'sources',
    // Bounded and non-empty as the authority demands, but the criterion below
    // quotes nothing, so this URL is never fetched.
    sources: [{ id: 'source', url: 'https://example.org/source' }],
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
  })
  const authorities = createVerifierAuthorities({ authorities: [documentAuthority] })
  const scope = Object.freeze({ workspace, preset: PRESET })
  const verifierOwner = Object.freeze({
    principalRecordId: OWNER_LINEAGE.principalRecordId,
    principalVersion: OWNER_LINEAGE.principalVersion,
  })
  const verifier = new AssistantVerifierService(ctx, {
    databasePath: join(workspace, 'verifier.sqlite'),
    tickIntervalMs: 0,
    requireAcceptance: true,
    authorities: [documentAuthority],
    profiles: [{
      id: 'whole-goal-profile',
      version: 1,
      scope,
      owner: verifierOwner,
      taskKind: 'goal-outcome',
      objective: OBJECTIVE,
      validityMs: 600_000,
      bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
      criteria: [{
        id: 'document',
        kind: 'document-citations',
        authority: { id: 'sources', digest: authorities[0]!.digest },
        artifactPath: 'report.md',
        requiredText: [REQUIRED_TEXT],
        quotes: [],
      }],
    }],
  })
  // Let the verifier's cordis effects discover and bind the goals producer and
  // the Evaluation outbox sink before any assessment completes.
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))

  const service = ctx.assistantEvolution

  /** Run one whole-goal assessment through acceptance → real objective
   * verification → Evaluation projection → dual-ledger trusted delivery. */
  const deliverFailedGoalOutcome = async (assessmentId: string): Promise<void> => {
    const task: AcceptanceTask = {
      scope,
      owner: verifierOwner,
      objective: OBJECTIVE,
      task: {
        kind: 'goal-outcome',
        ref: assessmentId,
        goal: {
          id: `goal-${assessmentId}`,
          definitionVersion: 1,
          definitionDigest: DEFINITION_DIGEST,
          assessmentId,
          sessionId: `session-${assessmentId}`,
          nativeGoalId: `native-${assessmentId}`,
        },
      },
    }
    const handle = producer.registration!.prepare(task)
    if (handle === null) throw new Error('whole-goal acceptance profile did not match')
    // Sampled strictly AFTER prepare (so >= contract.issuedAt) and reconciled
    // synchronously inside completed() below (so <= the verifier's clock there).
    // Equal dispatched/completed timestamps pass the strict < / > bind checks.
    const at = Date.now()
    // The execution genuinely finished and went quiescent; the objective
    // verdict (not-achieved) comes from the verifier's document criterion, not
    // from this status.
    producer.proof = {
      ...handle,
      dispatchedAt: at,
      completedAt: at,
      executionRef: task.task.ref,
      status: 'succeeded',
      quiescent: true,
    }
    await producer.registration!.completed(handle)
    await verifier.tick()
    await evaluation.reconcileProjections()
    await evaluation.whenProjectionIdle()
    const projected = evaluation.queryTasks({ scope, limit: 50 })
      .find(entry => entry.projection.subjectKind === 'goal-outcome'
        && entry.projection.subjectRef === assessmentId)
    if (projected === undefined) {
      throw new Error('whole-goal verifier receipt was not projected by Evaluation')
    }
    const evaluationId = projected.id
    // Deliver the SAME authoritative revision into the Evolution task-revision
    // ledger first (advancing its scope watermark in lockstep with Evaluation),
    // then admit the behavioural learning episode.
    const revision = service.projectTrustedEvaluationTaskRevision({ scope, evaluationId })
    expect(revision).toMatchObject({
      subjectKind: 'goal-outcome',
      subjectRef: assessmentId,
      disposition: 'upsert',
    })
    const episode = service.projectEvaluationOutcome({
      scope: canonicalEvolutionHostScope(scope),
      evaluationId,
    })
    expect(episode).toMatchObject({ situation: SITUATION, outcome: 'failed' })
  }

  return {
    ctx,
    service,
    policy,
    evolutionPath,
    workspace,
    goals,
    producer,
    verifier,
    deliverFailedGoalOutcome,
  }
}

function settleAdvice(
  goals: GoalStrategyStore,
  workspace: string,
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
  const scope = Object.freeze({
    principalId: OWNER,
    principalRecordId: OWNER_LINEAGE.principalRecordId,
    principalVersion: OWNER_LINEAGE.principalVersion,
    workspace,
    preset: PRESET,
  })
  goals.prepare({
    ...intentBase,
    id: input.id,
    goalId: input.goalId,
    definitionDigest: input.definitionDigest,
    scope,
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

function seedRepeatingAdvice(goals: GoalStrategyStore, workspace: string, definitionDigest: string): void {
  settleAdvice(goals, workspace, { id: 's1', goalId: 'goal-1', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 1, completedAt: 10 })
  settleAdvice(goals, workspace, { id: 's2', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'd'.repeat(64), createdAt: 2, completedAt: 20 })
  settleAdvice(goals, workspace, { id: 's3', goalId: 'goal-2', definitionDigest, requestDigest: '1'.repeat(64), outputDigest: 'c'.repeat(64), createdAt: 3, completedAt: 30 })
}

function queryRows(databasePath: string, sql: string): unknown[] {
  const database = new DatabaseSync(databasePath)
  try {
    return database.prepare(sql).all() as unknown[]
  } finally {
    database.close()
  }
}

function tableCount(databasePath: string, table: string): number {
  const rows = queryRows(databasePath, `SELECT COUNT(*) AS count FROM ${table}`) as { count: number }[]
  return rows[0]!.count
}

/** Dispatch an evolution tool through the REAL ToolRuntime, exactly as the
 * production analyst heartbeat agent loop does. */
function toolCall(name: string, args: Record<string, unknown>, agent: Agent) {
  return {
    callId: ToolCallId(`call-${name}-${Math.random()}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent,
  }
}

type ToolValue<T> = { isError: false; value: T } | { isError: true; value: unknown }

async function executeTool<T>(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent: Agent,
): Promise<ToolValue<T>> {
  return await ctx.tools.execute(toolCall(name, args, agent)) as ToolValue<T>
}

/** Read-only: resolve the evolution-local proposal id to the policy proposal
 * handle the OWNER uses to decide it (the analyst tool only returns the local
 * id; the two are attached synchronously on propose). */
function readPolicyProposalId(databasePath: string, localProposalId: string): string {
  const database = new DatabaseSync(databasePath)
  try {
    const row = database
      .prepare('SELECT policy_proposal_id AS id FROM evolution_proposals WHERE id = ?')
      .get(localProposalId) as { id: string | null } | undefined
    if (row === undefined || typeof row.id !== 'string') {
      throw new Error(`policy proposal not attached for local proposal ${localProposalId}`)
    }
    return row.id
  } finally {
    database.close()
  }
}

function injectedText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('supervised growth analyst goal-definition owner-gated adoption closure', () => {
  test('owner-approved goal-definition guidance reaches later foreground goal sessions, once per session', async () => {
    const target = await fixture()
    try {
      seedRepeatingAdvice(target.goals, target.workspace, DEFINITION_DIGEST)
      for (let index = 1; index <= 4; index += 1) {
        await target.deliverFailedGoalOutcome(`assessment-${index}`)
      }

      // The analyst heartbeat agent invokes its two bounded tools through the
      // REAL ToolRuntime + per-tool background execute policy. Nothing is
      // adopted by the analyst itself: propose only opens an owner approval.
      const analyst = analystAgent(target.workspace, 'occ-goal-closure-approved')
      const unbind = target.ctx.assistantPolicy.bindInitiator(analyst, 'background')
      const reviewResult = await executeTool<{
        contractVersion: string
        candidate?: { reviewToken: string; situation: string }
      }>(target.ctx, 'evolution_adoption_review', {}, analyst)
      expect(reviewResult.isError).toBe(false)
      const candidate = reviewResult.isError ? undefined : reviewResult.value.candidate
      expect(candidate?.situation).toBe(SITUATION)
      const reviewToken = candidate!.reviewToken

      const proposeResult = await executeTool<{
        proposalId: string
        status: string
        version: number
        replayed: boolean
      }>(target.ctx, 'evolution_adoption_propose', {
        review_token: reviewToken,
        guidance: GUIDANCE_TEXT,
      }, analyst)
      unbind()
      expect(proposeResult.isError).toBe(false)
      const proposedValue = proposeResult.isError ? undefined : proposeResult.value
      expect(proposedValue?.status).toBe('pending')
      const policyProposalId = readPolicyProposalId(target.evolutionPath, proposedValue!.proposalId)
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)

      // Before the owner decides, a foreground goal session receives nothing.
      const before = foregroundSession(target.workspace, 'before')
      agentEvents(target.ctx, before.agent).emit('agent/session-start', { source: 'startup' })
      expect(before.injections).toEqual([])
      expect(tableCount(target.evolutionPath, 'evolution_guidance_exposures')).toBe(0)

      // The OWNER approves; reconciliation activates the goal-definition rule.
      target.ctx.assistantPolicy.decideProposal({
        proposalId: policyProposalId,
        principal: OWNER,
        expectedVersion: 1,
        decision: 'approved',
        reason: 'owner confirmed the goal-definition guidance',
      })
      const settled = target.service.reconcileProposals()
      expect(settled).toHaveLength(1)
      expect(settled[0]).toMatchObject({
        status: 'approved',
        rule: { status: 'active', version: 1 },
      })

      const ruleRows = queryRows(
        target.evolutionPath,
        'SELECT id, situation, status, version FROM evolution_rules',
      ) as { id: string; situation: string; status: string; version: number }[]
      expect(ruleRows).toHaveLength(1)
      expect(ruleRows[0]!.situation).toBe(SITUATION)
      expect(ruleRows[0]!.situation.startsWith('goal-definition:')).toBe(true)
      expect(ruleRows[0]!.situation.startsWith('automation:')).toBe(false)
      const ruleId = ruleRows[0]!.id

      // A later ordinary foreground goal session in the same scope is injected
      // with the learned guidance through the generic unseen-rule path.
      const after = foregroundSession(target.workspace, 'after')
      agentEvents(target.ctx, after.agent).emit('agent/session-start', { source: 'startup' })
      expect(after.injections).toHaveLength(1)
      const text = injectedText(after.injections[0]!)
      expect(text).toContain('<learned_guidance>')
      expect(text).toContain(`when ${SITUATION}: ${GUIDANCE_TEXT}`)
      expect(text).toContain(`[rule ${ruleId}; generation 1]`)
      expect(text).toContain('cannot widen what you are allowed to do')

      // Exactly one durable exposure receipt for this session/rule.
      const exposures = queryRows(
        target.evolutionPath,
        'SELECT session_id, rule_id, scope_key FROM evolution_guidance_exposures',
      ) as { session_id: string; rule_id: string; scope_key: string }[]
      expect(exposures).toHaveLength(1)
      expect(exposures[0]!.rule_id).toBe(ruleId)
      expect(exposures[0]!.session_id).toBe(String(after.agent.session.id))
      expect(exposures[0]!.scope_key).toBe(canonicalEvolutionScope(target.workspace, PRESET))

      // Repeated session-start in the SAME session never injects twice: the
      // durable exposure dedupes it and no second receipt is written.
      agentEvents(target.ctx, after.agent).emit('agent/session-start', { source: 'startup' })
      expect(after.injections).toHaveLength(1)
      expect(tableCount(target.evolutionPath, 'evolution_guidance_exposures')).toBe(1)

      // A fresh foreground session still receives the guidance once.
      const later = foregroundSession(target.workspace, 'later')
      agentEvents(target.ctx, later.agent).emit('agent/session-start', { source: 'startup' })
      expect(later.injections).toHaveLength(1)
      expect(tableCount(target.evolutionPath, 'evolution_guidance_exposures')).toBe(2)
    } finally {
      target.goals.close()
    }
  })

  test('owner-rejected proposal never activates a rule and never injects foreground sessions', async () => {
    const target = await fixture()
    try {
      seedRepeatingAdvice(target.goals, target.workspace, DEFINITION_DIGEST)
      for (let index = 1; index <= 4; index += 1) {
        await target.deliverFailedGoalOutcome(`rejected-assessment-${index}`)
      }

      const analyst = analystAgent(target.workspace, 'occ-goal-closure-rejected')
      const unbind = target.ctx.assistantPolicy.bindInitiator(analyst, 'background')
      const reviewResult = await executeTool<{
        contractVersion: string
        candidate?: { reviewToken: string }
      }>(target.ctx, 'evolution_adoption_review', {}, analyst)
      expect(reviewResult.isError).toBe(false)
      const reviewToken = (reviewResult.isError ? undefined : reviewResult.value.candidate?.reviewToken)!
      const proposeResult = await executeTool<{ proposalId: string; status: string }>(
        target.ctx,
        'evolution_adoption_propose',
        { review_token: reviewToken, guidance: GUIDANCE_TEXT },
        analyst,
      )
      unbind()
      expect(proposeResult.isError).toBe(false)
      const localProposalId = (proposeResult.isError ? undefined : proposeResult.value.proposalId)!
      const policyProposalId = readPolicyProposalId(target.evolutionPath, localProposalId)

      target.ctx.assistantPolicy.decideProposal({
        proposalId: policyProposalId,
        principal: OWNER,
        expectedVersion: 1,
        decision: 'rejected',
        reason: 'owner declined this guidance',
      })
      const settled = target.service.reconcileProposals()
      expect(settled).toHaveLength(1)
      expect(settled[0]!.status).toBe('rejected')
      expect(settled[0]!.rule).toBeUndefined()
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)

      const foreground = foregroundSession(target.workspace, 'rejected')
      agentEvents(target.ctx, foreground.agent).emit('agent/session-start', { source: 'startup' })
      expect(foreground.injections).toEqual([])
      expect(tableCount(target.evolutionPath, 'evolution_guidance_exposures')).toBe(0)
    } finally {
      target.goals.close()
    }
  })

  test('the analyst tools fail closed outside the production-background automation path', async () => {
    const target = await fixture()
    try {
      seedRepeatingAdvice(target.goals, target.workspace, DEFINITION_DIGEST)
      for (let index = 1; index <= 4; index += 1) {
        await target.deliverFailedGoalOutcome(`authz-assessment-${index}`)
      }
      const noSideEffects = () => {
        // No review registered, no proposal opened, no rule touched.
        expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(0)
        expect(tableCount(target.evolutionPath, 'evolution_proposals')).toBe(0)
        expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)
        expect(target.ctx.assistantPolicy.listPendingApprovalDispatches()).toHaveLength(0)
      }

      // Gate 1 — policy: a real production analyst context dispatched under the
      // FOREGROUND initiator does not match the background-only execute grant.
      const foregroundAnalyst = analystAgent(target.workspace, 'occ-goal-closure-foreground')
      const unbindForeground = target.ctx.assistantPolicy.bindInitiator(foregroundAnalyst, 'foreground')
      const foregroundReview = await executeTool(
        target.ctx, 'evolution_adoption_review', {}, foregroundAnalyst,
      )
      expect(foregroundReview.isError).toBe(true)
      const foregroundPropose = await executeTool(
        target.ctx, 'evolution_adoption_propose',
        { review_token: 'analyst-review-forged', guidance: GUIDANCE_TEXT },
        foregroundAnalyst,
      )
      expect(foregroundPropose.isError).toBe(true)
      unbindForeground()
      noSideEffects()

      // Gate 2 — service: a background initiator that passes every per-tool
      // policy rule but carries NO frozen production automation context is
      // still rejected by the analyst authorization's second, independent gate.
      const contextless = analystAgent(target.workspace, 'occ-goal-closure-contextless', {
        automationExecution: false,
      })
      const unbindBackground = target.ctx.assistantPolicy.bindInitiator(contextless, 'background')
      const contextlessReview = await executeTool(
        target.ctx, 'evolution_adoption_review', {}, contextless,
      )
      expect(contextlessReview.isError).toBe(true)
      const contextlessPropose = await executeTool(
        target.ctx, 'evolution_adoption_propose',
        { review_token: 'analyst-review-forged', guidance: GUIDANCE_TEXT },
        contextless,
      )
      expect(contextlessPropose.isError).toBe(true)
      unbindBackground()
      noSideEffects()
    } finally {
      target.goals.close()
    }
  })
})
