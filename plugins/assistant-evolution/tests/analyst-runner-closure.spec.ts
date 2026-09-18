import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  acceptanceDigest,
  goalDefinitionSituation,
} from '@dsh-enhanced/task-acceptance-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type {
  AcceptedExecution,
  AcceptanceTask,
  TaskAcceptanceProducer,
  TaskAcceptanceRegistration,
} from '@dsh-enhanced/assistant-verifier'
import { afterEach, describe, expect, test } from 'vitest'
// The REAL automation runner under test. The package entry does not export it,
// so — exactly as this suite already reaches for the built sibling goals ledger
// at ../../assistant-goals/lib — we import the compiled sibling implementation.
import { DshAutomationRunner } from '../../assistant-automations/lib/runner.js'
import type { AutomationRunnerInput } from '../../assistant-automations/lib/coordinator.js'
import type { AgentAutomationDefinition } from '../../assistant-automations/lib/types.js'
import {
  AssistantEvolutionService,
  SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
  canonicalEvolutionHostScope,
  canonicalEvolutionScope,
} from '../src/service.ts'
import { GoalStrategyStore } from '../../assistant-goals/lib/strategy-store.js'
import { installQualityFixtures } from './quality-fixture.ts'

/**
 * Vertical production slice for the supervised-growth analyst heartbeat.
 *
 * Unlike analyst-goal-definition-closure.spec (which drives the two analyst
 * tools by calling ctx.tools.execute with a hand-built stub Agent), this test
 * runs the REAL DshAutomationRunner against a REAL AgentLoop:
 *
 *   a real Automation occurrence (production, not dry run)
 *     -> agents.create() builds the real background Agent, whose setup provides
 *        the frozen {mode,automationId,occurrenceId} and binds the background
 *        Policy initiator,
 *     -> the session-start observer writes the coherent full-access bundle
 *        (policy=never + reviewer=none + sandbox=danger-full-access), so the
 *        per-tool execute waterfall resolves reviewer 'none' and reaches the
 *        per-tool background execute Policy,
 *     -> the runner's immutable allowlist exposes EXACTLY the two analyst
 *        tools (every other registered global tool is deny-masked),
 *     -> a scripted LLM drives the real loop: round 1 calls
 *        evolution_adoption_review, round 2 reads the REAL review token out of
 *        the prior tool-result message and calls evolution_adoption_propose,
 *     -> both tools dispatch through the real ToolRuntime into the real
 *        Evolution service, whose evidence comes from the SAME real
 *        verifier -> Evaluation -> Evolution dual ledger as the closure spec
 *        (four genuinely not-achieved whole-goal outcomes + recurring real
 *        goals advice — never synthetic evidence),
 *     -> the analyst only opens an OWNER approval; an explicit owner decision
 *        is what activates the rule. Nothing self-adopts.
 *
 * A dry-run occurrence and a wrong-automationId production occurrence prove the
 * slice stays dark / fails closed. The delivery owner-route receipt and the
 * policy surroundings are engineering doubles; all *learning* evidence is real.
 */

const PRESET = 'primary'
const PROVIDER = 'mock'
const MODEL = 'analyst-model'
const OWNER = 'lark/bot-1/tenant-a/ou_owner'
const OWNER_LINEAGE = Object.freeze({ principalRecordId: 'principal-owner', principalVersion: 4 })
const OBJECTIVE = 'Draft the weekly sales summary from the CRM export.'
const DEFINITION_DIGEST = acceptanceDigest({ objective: OBJECTIVE })
const SITUATION = goalDefinitionSituation(DEFINITION_DIGEST)
const GUIDANCE_TEXT = 'Confirm the CRM export column layout before drafting the weekly sales summary.'
const REQUIRED_TEXT = 'VERIFIED COMPLETE WEEKLY SALES SUMMARY'
const REVIEW_TOOL = 'evolution_adoption_review'
const PROPOSE_TOOL = 'evolution_adoption_propose'
const ANALYST_TOOLS = Object.freeze([REVIEW_TOOL, PROPOSE_TOOL])

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

class GoalOutcomeProducer implements TaskAcceptanceProducer {
  readonly generation = `analyst-runner-closure-goals:${crypto.randomUUID()}`
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

/**
 * Scripted analyst LLM. Round 1 asks for the adoption review; round 2 mines the
 * REAL review token from the rendered (untrusted-wrapped) tool result and opens
 * the proposal; round 3 gives a final text answer. When the review is rejected
 * (fail-closed cases) there is no token, so round 2 ends the turn with text.
 * Dry-run runs expose no tools and finish with text on round 1.
 */
class AnalystAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly invoked: string[] = []

  constructor(private readonly dryRun = false) { super() }

  private tokenFromMessages(options: GenerateOptions): string | undefined {
    type LooseBlock = { type?: string; text?: string; content?: LooseBlock[] }
    const messages = options.messages as unknown as {
      role: string
      source?: { kind?: string }
      content: LooseBlock[]
    }[]
    for (const message of messages) {
      if (message.role !== 'user' || message.source?.kind !== 'tool') continue
      for (const result of message.content) {
        if (result.type !== 'tool-result') continue
        for (const block of result.content ?? []) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue
          const text = block.text
          const start = text.indexOf('{')
          const end = text.lastIndexOf('}')
          if (start === -1 || end <= start) continue
          try {
            const parsed = JSON.parse(text.slice(start, end + 1)) as {
              candidate?: { reviewToken?: unknown }
            }
            if (typeof parsed.candidate?.reviewToken === 'string') {
              return parsed.candidate.reviewToken
            }
          } catch {
            // Not the review result (or a wrapped error shape); keep scanning.
          }
        }
      }
    }
    return undefined
  }

  private async *finalAnswer(text: string, round: number): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10 + round, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async *toolCall(
    index: number,
    name: string,
    argumentsJson: string,
  ): AsyncIterable<StreamChunk> {
    const id = ToolCallId(`call-${index}`)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const round = this.requests.length
    // Dry run: the allowlist is empty, so answer immediately with text.
    if (this.dryRun) {
      yield* this.finalAnswer('dry run with no tools', round)
      return
    }
    if (round === 1) {
      this.invoked.push(REVIEW_TOOL)
      yield* this.toolCall(0, REVIEW_TOOL, '{}')
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const reviewToken = this.tokenFromMessages(options)
    if (reviewToken === undefined) {
      // The review was refused by the service's independent analyst gate.
      yield* this.finalAnswer('no adoption candidate available', round)
      return
    }
    if (round === 2) {
      this.invoked.push(PROPOSE_TOOL)
      yield* this.toolCall(
        0,
        PROPOSE_TOOL,
        JSON.stringify({ review_token: reviewToken, guidance: GUIDANCE_TEXT }),
      )
      yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 7 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* this.finalAnswer('analysis complete', round)
  }
}

interface Target {
  ctx: Context
  service: AssistantEvolutionService
  evolutionPath: string
  workspace: string
  goals: GoalStrategyStore
  producer: GoalOutcomeProducer
  verifier: AssistantVerifierService
  executionContexts: unknown[]
  deliverFailedGoalOutcome: (assessmentId: string) => Promise<void>
}

/**
 * A normal foreground goal session: no automation execution context, with a
 * real session/inbox and an inject() that records what the evolution plugin
 * pushes on session start. Used to prove the owner-adopted rule reaches later
 * ordinary sessions through the generic unseen-rule injection path.
 */
function foregroundSession(workspace: string, id: string): { agent: Agent; injections: UserMessage[] } {
  const sessionId = SessionId(`foreground-runner-${id}-${Math.random()}`)
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
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
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

function injectedText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

async function fixture(dryRunAdapter = false): Promise<Target & {
  adapter: AnalystAdapter
  runner: DshAutomationRunner
  runInput: (overrides?: { automationId?: string; dryRun?: boolean }) => AutomationRunnerInput
  definition: AgentAutomationDefinition
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'assistant-evolution-analyst-runner-'))
  roots.push(workspace)
  const ctx = new Context()
  contexts.add(ctx)

  // Real loop dependencies: LlmRuntime, SessionStore (sessions), SystemPrompt,
  // ToolRuntime, AgentRegistry. The Evolution plugin registers its tools on
  // this same runtime, so the runner-created Agent dispatches the real tools.
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  // AgentLoop flush projects through this registry, as in runner.spec.
  await ctx.plugin(SessionProjectionRegistry)

  ctx.provide('agentPresets' as never, {
    resolve: async (id?: string) => ({ id: id ?? PRESET }),
    // The analyst tools are global Evolution tools, so the preset needs no
    // tool mounts of its own.
    mount: async () => ({ id: PRESET }),
  } as never)

  await writeFile(join(workspace, 'report.md'), 'incomplete draft without the required line\n')

  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(workspace, 'policy.sqlite'),
    proposalMaintenanceIntervalMs: 0,
    rules: [
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
      {
        id: 'analyst-tool-review',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['execute'],
        resource: { kind: 'tool', id: REVIEW_TOOL },
        context: { initiators: ['background'] },
      },
      {
        id: 'analyst-tool-propose',
        effect: 'allow',
        subject: { kind: 'agent', id: PRESET, workspace },
        actions: ['execute'],
        resource: { kind: 'tool', id: PROPOSE_TOOL },
        context: { initiators: ['background'] },
      },
      // Ordinary foreground goal sessions: the guidance snapshot authorize, so
      // an owner-adopted rule is injected into later normal sessions.
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

  const { evaluation } = installQualityFixtures(ctx, join(workspace, 'evaluation.sqlite'))
  const evolutionPath = join(workspace, 'evolution.sqlite')
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    maxCandidates: 10,
    reconcileIntervalMs: 0,
  })

  const documentAuthority = Object.freeze({
    kind: 'document' as const,
    id: 'sources',
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
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))

  const service = ctx.assistantEvolution

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
    const at = Date.now()
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

  // The real background Agent's coherent full-access bundle, written by the
  // session-start observer exactly the production runtime relies on.
  const executionContexts: unknown[] = []
  ctx.on('agent/session-start', ({ agent: started }) => {
    executionContexts.push(started.ctx.get('assistantAutomationExecution'))
    started.session.append('approval/policy', { policy: 'never' })
    started.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = started.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(started.session, 'sandbox/mode', { mode: 'danger-full-access' })
  })

  const adapter = new AnalystAdapter(dryRunAdapter)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })

  const runner = new DshAutomationRunner(ctx, ctx.assistantPolicy, {
    allowUnbudgetedExecution: true,
  })

  const definition: AgentAutomationDefinition = {
    name: 'Supervised growth analyst',
    prompt: 'Review the adoption candidate and, if one is offered, propose guidance.',
    schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
    workspace,
    agentPreset: PRESET,
    provider: PROVIDER,
    model: MODEL,
    allowedTools: [...ANALYST_TOOLS],
    timeoutMs: 60_000,
    maxOutputTokens: 777,
    maxToolCalls: 2,
    misfire: { kind: 'latest' },
    overlap: 'skip',
    retrySafety: 'never',
    maxRetries: 0,
    principal: OWNER,
  }

  const runInput = (overrides: { automationId?: string; dryRun?: boolean } = {}): AutomationRunnerInput => {
    const automationId = overrides.automationId ?? SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID
    const dryRun = overrides.dryRun ?? false
    const occurrenceId = dryRun ? 'occ-analyst-preview' : 'occ-analyst-production'
    return {
      automation: {
        id: automationId, definition, status: 'active', nextRunAt: undefined,
        createdAt: 1, updatedAt: 1, version: 1,
      },
      occurrence: {
        id: occurrenceId, automationId, triggerKind: 'scheduled', triggerKey: 'heartbeat',
        scheduledAt: 1, status: 'pending', dryRun, createdAt: 1, updatedAt: 1,
      },
      task: {
        id: 'task-analyst', occurrenceId, automationId, status: 'running',
        cancelRequested: false, attemptCount: 1, createdAt: 1, updatedAt: 1,
      },
      sessionId: `automation-${occurrenceId}-1`,
      signal: new AbortController().signal,
    }
  }

  return {
    ctx,
    service,
    evolutionPath,
    workspace,
    goals,
    producer,
    verifier,
    executionContexts,
    deliverFailedGoalOutcome,
    adapter,
    runner,
    runInput,
    definition,
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

function tableCount(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath)
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    return row.count
  } finally {
    database.close()
  }
}

function queryRows(databasePath: string, sql: string): unknown[] {
  const database = new DatabaseSync(databasePath)
  try {
    return database.prepare(sql).all() as unknown[]
  } finally {
    database.close()
  }
}

/**
 * The runner swallows the tool return values into its run result, so resolve
 * the single proposal's local id AND the attached policy proposal handle the
 * OWNER uses to decide it (the two ids are attached synchronously on propose).
 */
function readSingleProposal(databasePath: string): { id: string; policyProposalId: string } {
  const rows = queryRows(
    databasePath,
    'SELECT id, policy_proposal_id AS policyProposalId FROM evolution_proposals',
  ) as { id: string; policyProposalId: string }[]
  if (rows.length !== 1 || typeof rows[0]!.id !== 'string'
    || typeof rows[0]!.policyProposalId !== 'string') {
    throw new Error(`expected exactly one evolution proposal, found ${rows.length}`)
  }
  return rows[0]!
}

async function seedRealEvidence(target: Target, prefix: string): Promise<void> {
  seedRepeatingAdvice(target.goals, target.workspace, DEFINITION_DIGEST)
  for (let index = 1; index <= 4; index += 1) {
    await target.deliverFailedGoalOutcome(`${prefix}-assessment-${index}`)
  }
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('supervised growth analyst real automation-runner vertical slice', () => {
  test('a production runner occurrence drives both analyst tools through the real loop and only the owner adopts', async () => {
    const target = await fixture()
    try {
      await seedRealEvidence(target, 'runner-hit')

      const result = await target.runner.run(target.runInput())

      // The run completed through the real AgentLoop: review round, proposal
      // round, then a final text answer.
      expect(result.outcome).toBe('succeeded')
      expect(result.output).toBe('analysis complete')
      expect(target.adapter.invoked).toEqual([REVIEW_TOOL, PROPOSE_TOOL])
      expect(target.executionContexts).toEqual([{
        mode: 'production',
        automationId: SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
        occurrenceId: 'occ-analyst-production',
      }])
      // Round 1 exposed EXACTLY the two allowlisted analyst tools — the other
      // five registered Evolution tools were deny-masked before the model ran.
      const roundOneTools = (target.adapter.requests[0]!.tools ?? [])
        .map(tool => tool.name)
        .sort()
      expect(roundOneTools).toEqual([...ANALYST_TOOLS].sort())

      // Real side effects: one review registered, one proposal opened, but the
      // analyst has NOT adopted anything.
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(1)
      expect(tableCount(target.evolutionPath, 'evolution_proposals')).toBe(1)
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)

      // The proposal produced through the real runner is a normal owner-gated
      // proposal: the analyst tool only returns the local id, which is attached
      // synchronously to the policy proposal handle the OWNER decides.
      const { policyProposalId } = readSingleProposal(target.evolutionPath)

      // Before the owner decides, an ordinary foreground goal session in the
      // same scope receives nothing.
      const before = foregroundSession(target.workspace, 'before')
      agentEvents(target.ctx, before.agent).emit('agent/session-start', { source: 'startup' })
      expect(before.injections).toEqual([])
      expect(tableCount(target.evolutionPath, 'evolution_guidance_exposures')).toBe(0)

      // The OWNER approves; reconciliation activates the goal-definition rule.
      // Nothing in the analyst run self-adopted it.
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

      // A later ordinary foreground goal session is injected with the learned
      // guidance through the generic unseen-rule path, once per session.
      const after = foregroundSession(target.workspace, 'after')
      agentEvents(target.ctx, after.agent).emit('agent/session-start', { source: 'startup' })
      expect(after.injections).toHaveLength(1)
      const text = injectedText(after.injections[0]!)
      expect(text).toContain('<learned_guidance>')
      expect(text).toContain(`when ${SITUATION}: ${GUIDANCE_TEXT}`)
      expect(text).toContain(`[rule ${ruleId}; generation 1]`)
      expect(text).toContain('cannot widen what you are allowed to do')

      const exposures = queryRows(
        target.evolutionPath,
        'SELECT session_id, rule_id, scope_key FROM evolution_guidance_exposures',
      ) as { session_id: string; rule_id: string; scope_key: string }[]
      expect(exposures).toHaveLength(1)
      expect(exposures[0]!.rule_id).toBe(ruleId)
      expect(exposures[0]!.session_id).toBe(String(after.agent.session.id))
      expect(exposures[0]!.scope_key).toBe(canonicalEvolutionScope(target.workspace, PRESET))

      // A repeated session-start in the SAME session never injects twice.
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

  test('a dry-run occurrence stays dark: no tools, no review, no proposal', async () => {
    const target = await fixture(true)
    try {
      await seedRealEvidence(target, 'runner-preview')

      const result = await target.runner.run(target.runInput({ dryRun: true }))

      // The preview occurrence still completes through the real loop, but with
      // an empty immutable allowlist.
      expect(result.outcome).toBe('succeeded')
      expect(result.output).toBe('dry run with no tools')
      expect(target.adapter.invoked).toEqual([])
      expect(target.executionContexts).toEqual([{
        mode: 'preview',
        automationId: SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID,
        occurrenceId: 'occ-analyst-preview',
      }])
      // No analyst tools were exposed to the model at all.
      expect(target.adapter.requests[0]!.tools ?? []).toEqual([])

      // No learning side effects whatsoever.
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_proposals')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)
      expect(target.ctx.assistantPolicy.listPendingApprovalDispatches()).toHaveLength(0)
    } finally {
      target.goals.close()
    }
  })

  test('a production occurrence for a different automation fails closed at the analyst gate', async () => {
    const target = await fixture()
    try {
      await seedRealEvidence(target, 'runner-wrong-automation')

      // A frozen production context whose automationId is NOT the supervised
      // analyst heartbeat passes the runner (it installs its own context) and
      // the per-tool background execute policy, but the Evolution service's
      // independent analyst gate rejects both tools. The turn still finishes.
      const result = await target.runner.run({
        ...target.runInput({ automationId: 'heartbeat:some-other-automation' }),
      })

      expect(result.outcome).toBe('succeeded')
      // Round 1 called review (refused), so there was no token and the adapter
      // ended the turn with text rather than proposing.
      expect(target.adapter.invoked).toEqual([REVIEW_TOOL])
      expect(result.output).toBe('no adoption candidate available')
      expect(target.executionContexts).toEqual([{
        mode: 'production',
        automationId: 'heartbeat:some-other-automation',
        occurrenceId: 'occ-analyst-production',
      }])

      // The refused review registered nothing and no proposal/rule exists.
      expect(tableCount(target.evolutionPath, 'evolution_supervised_analyst_reviews')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_proposals')).toBe(0)
      expect(tableCount(target.evolutionPath, 'evolution_rules')).toBe(0)
      expect(target.ctx.assistantPolicy.listPendingApprovalDispatches()).toHaveLength(0)
    } finally {
      target.goals.close()
    }
  })
})
