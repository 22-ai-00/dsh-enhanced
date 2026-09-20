/**
 * Engineering-layer integration tests for the opt-in assistant-growth-driver.
 *
 * IMPORTANT — these are NOT real external-provider evidence: every model
 * interaction is served by a scripted in-process LlmAdapter registered for the
 * 'super-relay' provider and nothing here touches the network or a real Super
 * Relay account.  What IS exercised for real is the Host control plane:
 * the frozen realm tool surface, the independent owner-success re-verification
 * inside assistant-skills, the real sqlite policy/skills stores, the approval
 * seam and the fail-closed preflight order.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { OwnerVerifiedWorkflowSourceError, type GoalRecord, type GoalScope, type VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'
import plugin, { apply, AssistantGrowthDriverService, name, normalizeConfig, version } from '../src/index.ts'
import type { OwnerRouteReceipt } from '../src/deposit.ts'
import type { GrowthSourcePlanePort } from '../src/source-port.ts'

// Contract expiry is unreachable with the wall clock while the pinned contract
// is still current, so the single assertCurrentContract call is gated through
// a hoisted switch; every other package export keeps its real implementation.
const contractState = vi.hoisted(() => ({ expired: false }))
vi.mock('@dsh-enhanced/assistant-super-relay-budget', async importOriginal => {
  const actual = await importOriginal<typeof import('@dsh-enhanced/assistant-super-relay-budget')>()
  return {
    ...actual,
    assertCurrentContract(now?: number): void {
      if (contractState.expired) throw new Error('assistant-super-relay-budget: Super Relay protocol contract has expired')
      actual.assertCurrentContract(now)
    },
  }
})

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

const PRESET = 'primary'
const PRINCIPAL = 'owner-1'
const RECORD_ID = 'record-owner-1'
const OWNER_ROUTE = 'owner-route'
const SKILL_NAME = 'repeat-write-result'
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

interface Harness {
  ctx: Context
  root: string
  skillsPath: string
  scope: GoalScope
  receipts: ReturnType<typeof vi.fn>
  modelSelection: ReturnType<typeof vi.fn>
  learningSource: ReturnType<typeof vi.fn>
  goalsApi: { inspectOwnerGoals: ReturnType<typeof vi.fn>; inspectOwnerVerifiedWorkflowSource: ReturnType<typeof vi.fn> }
  approval: { request: ReturnType<typeof vi.fn> }
  /** Scripted Delivery owner-anchored commit seam (engineering layer; no real Goals/DB behind it). */
  ownerAnchoredCommit: ReturnType<typeof vi.fn>
  /** Raw service instance: a traceable-Proxy method call fails ES #private brand checks. */
  skills: AssistantSkillsService | undefined
}

function buildReceipt(workspace: string, generation: number): Readonly<OwnerRouteReceipt> {
  return Object.freeze({
    receiptVersion: 2,
    authorityId: OWNER_ROUTE,
    authorityHash: `anchor-hash-${generation}`,
    principalId: PRINCIPAL,
    principalRecordId: RECORD_ID,
    principalVersion: 1,
    workspace,
    agentPreset: PRESET,
    bindingVersion: 1,
    generation,
  })
}

function ownerScope(workspace: string): GoalScope {
  return Object.freeze({ principalId: PRINCIPAL, principalRecordId: RECORD_ID, principalVersion: 1, workspace, preset: PRESET })
}

function goalRecord(workspace: string, sessionId: string, goalId: string, index: number): GoalRecord {
  const scope = ownerScope(workspace)
  return Object.freeze({
    id: goalId,
    scope,
    originalObjective: `Repeatable write procedure ${index}`,
    definition: Object.freeze({ version: 1, digest: `goal-def-${goalId}`, objective: `Repeatable write procedure ${index}` }),
    native: Object.freeze({
      sessionId, goalId, revision: 3, objective: `Repeatable write procedure ${index}`,
      phase: 'complete' as const, roundsStarted: 1, maxGoalRounds: 4, updatedAt: 1_700_000_000_000 + index,
    }),
    checkpoint: Object.freeze({ nextStep: 'done', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }),
    version: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000 + index,
  })
}

const LOCATORS = [
  { sessionId: 'sess-1', goalId: 'goal-1' },
  { sessionId: 'sess-2', goalId: 'goal-2' },
  { sessionId: 'sess-3', goalId: 'goal-3' },
] as const

/**
 * Fresh, complete owner goal inside the owner-anchored lookback horizon. The
 * fixed goalRecord() timestamps are 2023-dated and deliberately fall outside
 * the default 24h lookback, so track tests build these instead. Engineering
 * layer fixture — not real owner-root Goals evidence.
 */
function freshGoalRecord(workspace: string, sessionId: string, goalId: string, index: number, now: number): GoalRecord {
  const base = goalRecord(workspace, sessionId, goalId, index)
  const updatedAt = now - index * 1_000
  return Object.freeze({
    ...base,
    native: Object.freeze({ ...base.native, updatedAt }),
    updatedAt,
  })
}

function freshGoals(workspace: string, now: number, count: number): GoalRecord[] {
  return Array.from({ length: count }, (_, index) =>
    freshGoalRecord(workspace, `oa-sess-${index + 1}`, `oa-goal-${index + 1}`, index, now))
}

type ScriptedCommitResult =
  | { readonly outcome: 'trace-recorded'; readonly revision: number; readonly template: Readonly<Record<string, unknown>>; readonly replayed: boolean }
  | { readonly outcome: 'abstained'; readonly reason: 'not-reducible'; readonly replayed: false }

const TRACE_RECORDED: ScriptedCommitResult = Object.freeze({ outcome: 'trace-recorded', revision: 1, template: Object.freeze({}), replayed: false })
const TRACE_REPLAYED: ScriptedCommitResult = Object.freeze({ ...TRACE_RECORDED, replayed: true })
const ABSTAINED: ScriptedCommitResult = Object.freeze({ outcome: 'abstained', reason: 'not-reducible', replayed: false })

function verifiedSource(workspace: string, sessionId: string, goalId: string): VerifiedWorkflowSource {
  return Object.freeze({
    protocol: 'assistant-goals/verified-workflow-source/v1',
    scope: ownerScope(workspace),
    goal: Object.freeze({
      id: goalId,
      definition: Object.freeze({ version: 1, digest: `goal-def-${goalId}`, objective: `Repeatable procedure for ${goalId}` }),
      sessionId,
      nativeGoalId: `native-${goalId}`,
    }),
    runId: `goal-run-${goalId}`,
    turn: 1,
    acceptance: Object.freeze({
      contractId: `contract-${goalId}`, contractDigest: `contract-digest-${goalId}`, receiptDigest: `receipt-digest-${goalId}`,
      verifiedAt: 1_700_000_000_000, validUntil: 1_900_000_000_000,
    }),
    steps: Object.freeze([
      Object.freeze({ id: `write-${goalId}`, toolName: 'write', arguments: Object.freeze({ file_path: `result-${goalId}.sh`, content: `echo verified ${goalId}\n` }) }),
    ]),
  })
}

interface ScriptedTurn { name: string; args: Record<string, unknown> }

/**
 * Scripted model (engineering layer only — replaces a real Super Relay call):
 * emits one tool-call turn per scripted entry, then a final stop text turn.
 * reset() replays the same script for a second wake on the same adapter
 * instance (registerAdapter binds one process-lifetime adapter per provider).
 */
class ScriptedAdapter extends LlmAdapter {
  calls = 0
  requests: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
  onRequest?: () => void
  surfaces: string[][] = []
  constructor(private readonly turns: readonly ScriptedTurn[]) { super() }
  reset(): void { this.calls = 0 }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ provider: options.provider, model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) })
    this.onRequest?.()
    this.surfaces.push((options.tools ?? []).map(tool => tool.name).sort())
    const index = this.calls++
    if (index < this.turns.length) {
      const turn = this.turns[index]!
      const id = ToolCallId(`growth-call-${index}`)
      const argumentsText = JSON.stringify(turn.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: turn.name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: turn.name, arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'growth review complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function successTurns(): ScriptedTurn[] {
  return [
    { name: 'growth_list_owner_goals', args: {} },
    ...LOCATORS.map(locator => ({ name: 'growth_read_verified_workflow', args: { session_id: locator.sessionId, goal_id: locator.goalId } })),
    { name: 'growth_list_skills', args: {} },
    {
      name: 'growth_propose_skill_candidate',
      args: {
        success_locators: LOCATORS.map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId })),
        name: SKILL_NAME,
        description: 'Re-run the verified repeatable write procedure.',
      },
    },
  ]
}

interface MountOptions {
  withPolicy?: boolean
  budgetLimit?: number
  rejectedGoals?: ReadonlySet<string>
  /** When set, every validateOwnerRoute call after the mint returns this generation. */
  rebindGeneration?: number
  adapter?: LlmAdapter
  provider?: string
  registerSkills?: boolean
  /**
   * Goals returned by inspectOwnerGoals for the owner-anchored track. Defaults
   * to the fixed 2023-dated LOCATORS, which fall OUTSIDE the default 24h
   * lookback; pass fresh records (updatedAt near Date.now()) to exercise the
   * track. Engineering-layer fixtures only — not real Goals evidence.
   */
  ownerAnchoredGoals?: readonly GoalRecord[]
  /** Per-goalId result of Delivery.commitOwnerAnchoredWorkflowTrace. */
  commitResultById?: ReadonlyMap<string, unknown>
  /** Goals whose commit throws an AssistantDeliveryError-shaped exception. */
  commitThrowById?: ReadonlyMap<string, { code: string; message: string }>
}

const contexts: Context[] = []
const roots: string[] = []

async function mount(opts: MountOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-growth-driver-'))
  const ctx = new Context()
  contexts.push(ctx)
  roots.push(root)

  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(SessionProjectionRegistry)

  // Fake approval seam: the tools/pre-execute waterfall resolves unknown
  // growth_* names as `ask`, and ToolRuntime routes that through this channel.
  const approval = { config: { policy: 'ask' }, request: vi.fn(async () => 'allowed-once' as const) }
  ctx.provide('approval' as never, approval as never)

  const scope = ownerScope(root)
  let routeCalls = 0
  const receipts = vi.fn(() => {
    routeCalls += 1
    const generation = opts.rebindGeneration !== undefined && routeCalls > 1 ? opts.rebindGeneration : 1
    return buildReceipt(root, generation)
  })
  // Engineering-layer stand-in for Delivery.commitOwnerAnchoredWorkflowTrace:
  // it records the locator/authority the driver passed and returns a scripted
  // outcome. No real Goals re-verification or sqlite projection happens here.
  const ownerAnchoredCommit = vi.fn(async (input: { locator: { goalId: string } }) => {
    const thrown = opts.commitThrowById?.get(input.locator.goalId)
    if (thrown !== undefined) {
      const error = new Error(thrown.message) as Error & { code?: string }
      error.code = thrown.code
      throw error
    }
    return opts.commitResultById?.get(input.locator.goalId)
      ?? { outcome: 'trace-recorded' as const, revision: 1, template: {}, replayed: false }
  })
  const modelSelection = vi.fn(() => ({ provider: 'super-relay', model: 'auto_model/alwaysday1' }))
  const learningSource = vi.fn()
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: receipts,
    inspectOwnerModelSelection: modelSelection,
    inspectOwnerForegroundLearningTask: learningSource,
    commitOwnerAnchoredWorkflowTrace: ownerAnchoredCommit,
  } as never)

  const goalsApi = {
    inspectOwnerGoals: vi.fn(() => opts.ownerAnchoredGoals
      ?? LOCATORS.map((locator, index) => goalRecord(root, locator.sessionId, locator.goalId, index))),
    inspectOwnerVerifiedWorkflowSource: vi.fn(async (input: { sessionId: string; goalId: string }) => {
      if (opts.rejectedGoals?.has(input.goalId)) throw new OwnerVerifiedWorkflowSourceError('rejected', `assistant-goals: ${input.goalId} is not an owner-root success`)
      return verifiedSource(root, input.sessionId, input.goalId)
    }),
  }
  ctx.provide('assistantGoals' as never, goalsApi as never)

  if (opts.adapter !== undefined) ctx.llm.registerAdapter([opts.provider ?? 'super-relay'], opts.adapter)
  await ctx.plugin(AgentLoop, { agents: [] })

  if (opts.withPolicy !== false) {
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [{ id: 'growth-budget', metric: 'automation-runs', limit: opts.budgetLimit ?? 20, periodMs: 60_000, scope: 'subject' }],
      rules: [
        { id: 'usage-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-growth-usage', workspace: root, principal: PRINCIPAL },
          actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        { id: 'usage-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: PRINCIPAL },
          actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        {
          id: 'growth-draft', effect: 'allow',
          subject: { kind: 'agent', id: PRESET, workspace: root, principal: PRINCIPAL },
          actions: ['draft'], resource: { kind: 'evolution', id: 'verified-workflows' },
          context: { initiators: ['background'] },
        },
        {
          id: 'growth-tool-execute', effect: 'allow',
          subject: { kind: 'agent', id: PRESET, workspace: root, principal: PRINCIPAL },
          actions: ['execute'], resource: { kind: 'tool', id: 'growth_*' },
          context: { initiators: ['background'] },
        },
        {
          id: 'source-tool-execute', effect: 'allow',
          subject: { kind: 'agent', id: PRESET, workspace: root, principal: PRINCIPAL },
          actions: ['execute'], resource: { kind: 'tool', id: 'plugin_source_*' },
          context: { initiators: ['background'] },
        },
      ],
    })
  }
  if (opts.registerSkills !== false) {
    await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'] })
  }

  // The skills service registers its global skill_* tools from a cordis inject
  // callback; wait for that to settle so the growth agent's global snapshot is
  // taken against the real post-plugin surface.
  if (opts.registerSkills !== false && opts.withPolicy !== false) {
    await vi.waitFor(() => {
      const tools = ctx.get('tools' as never) as { schemas: () => Array<{ name: string }> } | undefined
      if (tools === undefined || !tools.schemas().some(schema => schema.name === 'skill_save')) {
        throw new Error('assistant-skills global tools not registered yet')
      }
    }, { timeout: 2_000 })
  }

  const skills = opts.registerSkills === false
    ? undefined
    : (ctx.get('assistantSkills' as never) as unknown as { [CORDIS_ORIGINAL]: AssistantSkillsService })[CORDIS_ORIGINAL]
  return { ctx, root, skillsPath: join(root, 'skills.sqlite'), scope, receipts, modelSelection, learningSource, goalsApi, approval, ownerAnchoredCommit, skills }
}

afterEach(async () => {
  contractState.expired = false
  delete process.env.SUPER_RELAY_API_KEY
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function tableCounts(h: Harness): { candidates: number; definitions: number; runs: number } {
  const db = new DatabaseSync(h.skillsPath)
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    return { candidates: count('skill_candidates'), definitions: count('skill_definitions'), runs: count('skill_runs') }
  } finally { db.close() }
}

function candidateRows(h: Harness): Array<{ id: string; state: string; name: string }> {
  const db = new DatabaseSync(h.skillsPath)
  try {
    const rows = db.prepare('SELECT candidate_json FROM skill_candidates').all() as Array<{ candidate_json: string }>
    return rows.map(row => {
      const candidate = JSON.parse(row.candidate_json) as { id: string; state: string; definition: { name: string } }
      return { id: candidate.id, state: candidate.state, name: candidate.definition.name }
    })
  } finally { db.close() }
}

function driverConfig(root: string, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalMs: 0,
    scope: { workspace: root, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: OWNER_ROUTE },
    ...overrides,
  }
}

async function runWake(service: AssistantGrowthDriverService): Promise<void> {
  // The wake may either resolve normally or surface hook cancellation as a
  // rejection depending on where the frozen contract trips; health() records
  // both, so callers assert on health and durable writes instead.
  try { await service.wake() } catch { /* health() is the source of truth */ }
}

describe('dsh-enhanced-assistant-growth-driver', () => {
  it('automatically reviews actual task feedback through native scheduling and the source model', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter, provider: 'conversation-provider' })
    h.modelSelection.mockImplementation(() => { throw new Error('current conversation was switched; do not read it') })
    await h.ctx.plugin(AssistantEvaluationService, { databasePath: join(h.root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
    await h.ctx.plugin(AssistantAutomationsService, { databasePath: join(h.root, 'automations.sqlite'), runsPath: join(h.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
    const evaluation = h.ctx.assistantEvaluation
    const producer = new EvaluationStore({ path: join(h.root, 'evaluation.sqlite') })
    const task = producer.append({ scope: { workspace: h.root, preset: PRESET }, situation: 'foreground:real-task',
      executionStatus: 'succeeded', objectiveStatus: 'not-achieved', deliveryStatus: 'delivered', trust: 'trusted',
      source: { kind: 'evaluator', id: 'assistant-verifier' }, evaluator: { id: 'assistant-verifier', version: '1' },
      evidence: [{ kind: 'foreground-turn', ref: 'real-task' }, { kind: 'acceptance-contract', ref: 'contract' }, { kind: 'verification-receipt', ref: 'receipt' }],
      metrics: {}, occurredAt: Date.now(), idempotencyKey: 'real-task-result' })
    producer.close()
    h.learningSource.mockImplementation(() => ({ protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: buildReceipt(h.root, 1),
      canonical: evaluation.getTrustedTaskLearningProjection({ scope: evaluation.canonicalHostScope({ workspace: h.root, preset: PRESET }), outcomeId: task.id }),
      judgement: 'independent-verifier', source: { sessionId: 'real-session', inboxId: 'real-task', objective: 'The actual user report has a missing total.',
        truncated: false, quiescent: true, modelSelectionState: 'frozen', modelSelection: { provider: 'conversation-provider', model: 'original-task-model' } } }))
    const prompts: string[] = []
    h.ctx.on('llm/stream', async function* (options, next) { prompts.push(JSON.stringify(options.messages)); yield* next() })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { budgetId: 'growth-budget', budgetAmount: 1,
      usageLearning: { enabled: true, databasePath: join(h.root, 'usage.sqlite') } }))
    await vi.waitFor(() => expect(service.usageHealth()).toMatchObject({ connected: true, counts: { queued: 1 } }))
    await new Promise(resolve => setTimeout(resolve, 1100))
    for (let i = 0; i < 3; i += 1) { await h.ctx.assistantAutomations.tick(); await h.ctx.assistantAutomations.whenIdle() }
    expect(service.usageHealth()).toMatchObject({ counts: { reviewed: 1 } })
    expect(adapter.requests).toEqual([{ provider: 'conversation-provider', model: 'original-task-model' }])
    expect(h.modelSelection).not.toHaveBeenCalled()
    expect(prompts.join('\n')).toContain('The actual user report has a missing total.')
    expect(prompts.join('\n')).toContain('untrusted task data')
    expect(prompts.join('\n')).not.toContain(RECORD_ID)
  })
  it('inherits the owner conversation model, freezes it for the wake, and rereads it next wake', async () => {
    const adapter = new ScriptedAdapter([{ name: 'growth_list_owner_goals', args: {} }])
    const h = await mount({ adapter, provider: 'conversation-provider' })
    const selected = { provider: 'conversation-provider', model: 'conversation-model' }
    h.modelSelection.mockReturnValue(selected)
    adapter.onRequest = () => { selected.model = 'next-model' }
    // An unrelated supplier's expired contract and absent credential must not
    // disable the conversation's own adapter.
    contractState.expired = true
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await service.wake()
    expect(service.health()).toMatchObject({ outcome: 'ran', reason: 'succeeded',
      run: { model: { provider: 'conversation-provider', model: 'conversation-model' } } })
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.every(request => request.model === 'conversation-model')).toBe(true)
    adapter.reset()
    await service.wake()
    expect(adapter.requests.slice(2).every(request => request.model === 'next-model')).toBe(true)
  })

  it('uses an explicit fixed model without reading or depending on conversation model selection', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter, provider: 'repair-provider' })
    h.modelSelection.mockImplementation(() => { throw new Error('no source model') })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      provider: 'repair-provider', model: 'repair-model',
    }))
    await service.wake()
    expect(adapter.requests).toEqual([{ provider: 'repair-provider', model: 'repair-model' }])
    expect(h.modelSelection).not.toHaveBeenCalled()
    expect(service.health()).toMatchObject({ outcome: 'ran', reason: 'succeeded' })
  })

  it('does not invent a default model when inherited selection is unavailable', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter })
    h.modelSelection.mockImplementation(() => { throw new Error('source unavailable') })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await service.wake()
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: 'missing-model:source unavailable' })
    expect(adapter.calls).toBe(0)
  })

  it('requires a complete fixed model pair and rejects malformed routes', () => {
    expect(normalizeConfig({})).toMatchObject({ provider: null, model: null, apiKeyEnv: null })
    expect(() => normalizeConfig({ provider: 'provider' })).toThrow(/together/)
    expect(() => normalizeConfig({ model: 'model' })).toThrow(/together/)
    expect(() => normalizeConfig({ reasoningEffort: 'high' })).toThrow(/explicit provider/)
    expect(() => normalizeConfig({ provider: ' bad ', model: 'model' })).toThrow(/invalid model/)
  })

  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-growth-driver')
    expect(version).toBe(manifest.version)
  })

  it('loads disabled through the Cordis entrypoint and never runs', async () => {
    // apply() IS the Cordis entrypoint; it must accept the empty config.
    const entryCtx = new Context()
    contexts.push(entryCtx)
    expect(() => apply(entryCtx, {})).not.toThrow()

    // Hold a constructor instance on a separate ctx for the health assertions:
    // a ctx only accepts one registration per service name.
    const ctx = new Context()
    contexts.push(ctx)
    const service = new AssistantGrowthDriverService(ctx, {})
    await service.wake()
    expect(service.health()).toMatchObject({ outcome: 'never-run', reason: null, run: null })
  })

  it('refuses to enable without an explicit frozen owner scope', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new AssistantGrowthDriverService(ctx, { enabled: true })).toThrow(/owner scope/)
  })

  it('supports wake and health through a real injected Cordis service proxy', async () => {
    const h = await mount()
    new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    let consumer: Context | undefined
    await h.ctx.inject(['assistantGrowthDriver' as never], ctx => { consumer = ctx })
    const proxy = consumer!.get('assistantGrowthDriver' as never) as unknown as Pick<AssistantGrowthDriverService, 'wake' | 'health'>
    await proxy.wake()
    expect(proxy.health()).toMatchObject({ outcome: 'skipped', reason: 'missing-credential' })
  })

  it('skips the wake when the owner route cannot be anchored (missing-binding)', async () => {
    const h = await mount()
    h.receipts.mockImplementation(() => { throw new Error('assistant-delivery: owner route revoked') })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^missing-binding:/) })
    expect(tableCounts(h)).toMatchObject({ candidates: 0 })
  })

  it('skips fail-closed when the super-relay contract has expired (contract-expired; engineering layer)', async () => {
    const h = await mount()
    contractState.expired = true
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^contract-expired:/) })
    expect(tableCounts(h)).toMatchObject({ candidates: 0 })
  })

  it('skips fail-closed when no super-relay credential resolves (missing-credential)', async () => {
    const h = await mount()
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: 'missing-credential' })
    expect(tableCounts(h)).toMatchObject({ candidates: 0 })
  })

  it('skips fail-closed when no policy service is mounted (missing-policy)', async () => {
    const h = await mount({ withPolicy: false })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: 'missing-policy' })
  })

  it('skips fail-closed when the wake budget reservation is rejected (budget-exhausted)', async () => {
    const h = await mount({ budgetLimit: 5 })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { budgetId: 'growth-budget', budgetAmount: 6 }))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^budget:/) })
    expect(tableCounts(h)).toMatchObject({ candidates: 0 })
  })

  it('deposits exactly one pending candidate after 3 distinct verified successes, and never activates (engineering layer, mock provider)', async () => {
    const turns = successTurns()
    const adapter = new ScriptedAdapter(turns)
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { budgetId: 'growth-budget', budgetAmount: 1 }))
    await runWake(service)

    const health = service.health()
    expect(health.outcome).toBe('ran')
    expect(health.reason).toBe('succeeded')
    expect(adapter.calls).toBe(turns.length + 1)

    const counts = tableCounts(h)
    expect(counts).toMatchObject({ candidates: 1, definitions: 0, runs: 0 })
    const rows = candidateRows(h)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'pending', name: SKILL_NAME })

    // Nothing reaches the current-definition table, so skill_run can never see
    // it.  Read through the RAW service instance: a cordis traceable-Proxy
    // method call rebinds `this` and fails the store/state #private brand
    // checks (the driver unwraps the same marker internally before calling in).
    const skills = h.skills!
    expect(skills.inspectOwnerActiveSkills(h.scope)).toHaveLength(0)
    const pending = skills.inspectOwnerSkillCandidates(h.scope)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ state: 'pending' })

    // The Host re-reads each locator independently on top of the model's read
    // passes: 3 model reads + 3 stage verifications.
    expect(h.goalsApi.inspectOwnerVerifiedWorkflowSource).toHaveBeenCalledTimes(LOCATORS.length * 2)

    // The background budget reserve→finalize pair is in the audit trail.
    const audit = (h.ctx.get('assistantPolicy' as never) as unknown as AssistantPolicyService).queryAudit()
    const reserves = audit.filter(event => event.action === 'budget.reserve')
    const finalizes = audit.filter(event => event.action === 'budget.finalize')
    expect(reserves.at(-1)).toMatchObject({ outcome: 'reserved' })
    expect(finalizes.at(-1)).toMatchObject({ outcome: 'finalized' })

    // Every realm tool execution crossed the (fake) owner approval seam.
    expect(h.approval.request).toHaveBeenCalled()
  })

  it('is idempotent: a second identical wake keeps the single pending candidate id', async () => {
    const adapter = new ScriptedAdapter(successTurns())
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(tableCounts(h)).toMatchObject({ candidates: 1 })
    const firstId = candidateRows(h)[0]!.id

    adapter.reset()
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'ran', reason: 'succeeded' })
    expect(tableCounts(h)).toMatchObject({ candidates: 1 })
    const secondRows = candidateRows(h)
    expect(secondRows).toHaveLength(1)
    expect(secondRows[0]!.id).toBe(firstId)
  })

  it('rejects a single-locator proposal even when the model omits minimum_occurrences (Host floor)', async () => {
    const turns: ScriptedTurn[] = [
      { name: 'growth_list_owner_goals', args: {} },
      { name: 'growth_read_verified_workflow', args: { session_id: LOCATORS[0]!.sessionId, goal_id: LOCATORS[0]!.goalId } },
      { name: 'growth_list_skills', args: {} },
      {
        name: 'growth_propose_skill_candidate',
        // Model tries to stage after one success and omits the threshold arg.
        args: { success_locators: [LOCATORS[0]], name: SKILL_NAME, description: 'Should be rejected.' },
      },
    ]
    const h = await mount({ adapter: new ScriptedAdapter(turns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { minRepeatedSuccesses: 3 }))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'ran' })
    expect(tableCounts(h)).toMatchObject({ candidates: 0, definitions: 0, runs: 0 })
  })

  it('writes nothing when an offered locator is independently rejected as non-owner-root', async () => {
    const turns: ScriptedTurn[] = [
      { name: 'growth_list_owner_goals', args: {} },
      ...LOCATORS.map(locator => ({ name: 'growth_read_verified_workflow', args: { session_id: locator.sessionId, goal_id: locator.goalId } })),
      { name: 'growth_list_skills', args: {} },
      {
        name: 'growth_propose_skill_candidate',
        args: {
          success_locators: LOCATORS.map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId })),
          name: SKILL_NAME,
          description: 'One locator is forged.',
        },
      },
    ]
    const h = await mount({ adapter: new ScriptedAdapter(turns), rejectedGoals: new Set(['goal-2']) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(service.health()).toMatchObject({ outcome: 'ran' })
    expect(tableCounts(h)).toMatchObject({ candidates: 0, definitions: 0, runs: 0 })
  })

  it('skips before model dispatch with zero writes when the owner route is re-bound during selection', async () => {
    const h = await mount({ adapter: new ScriptedAdapter(successTurns()), rebindGeneration: 2 })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    const health = service.health()
    expect(health.outcome).toBe('skipped')
    expect(health.reason).toEqual(expect.stringContaining('owner route changed'))
    expect(tableCounts(h)).toMatchObject({ candidates: 0, definitions: 0, runs: 0 })
    // The rebind is detected while freezing the route, before any history is read.
    expect(h.goalsApi.inspectOwnerVerifiedWorkflowSource).not.toHaveBeenCalled()
  })

  it('enforces the frozen tool-call budget and the proposal never lands (engineering layer)', async () => {
    // 6 scripted tool calls, but the frozen contract allows only 2.
    const h = await mount({ adapter: new ScriptedAdapter(successTurns()) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { maxToolCalls: 2, maxModelCalls: 8 }))
    await runWake(service)
    const health = service.health()
    expect(['ran', 'failed']).toContain(health.outcome)
    expect(tableCounts(h)).toMatchObject({ candidates: 0, definitions: 0, runs: 0 })
  })
})

// Workspace token for owner-anchored fixtures. The driver only reads each
// enumerated record's id and native.sessionId; scope filtering is Goals' job,
// so this constant need not equal the harness mount root.
const OA_WS = 'owner-anchored-ws'

// The owner-anchored track runs purely Host-local (Goals re-read + Delivery
// commit, no model/network), so these tests need NO scripted LLM adapter and
// exercise the track ahead of the super-relay credential gate. Every Goals and
// Delivery response is a scripted engineering-layer fixture — never real
// owner-root evidence or a real external provider.
describe('assistant-growth-driver owner-anchored workflow track (engineering layer, not real Goals/provider evidence)', () => {
  it('leaves the track off by default: zero commits and no ownerAnchored health field', async () => {
    const h = await mount({ ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 3) })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root))
    await runWake(service)
    expect(h.ownerAnchoredCommit).not.toHaveBeenCalled()
    expect(service.health().ownerAnchored).toBeUndefined()
  })

  it('refuses to switch the track on while the driver itself is disabled', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new AssistantGrowthDriverService(ctx, { enabled: false, workflowOwnerAnchored: { enabled: true } }))
      .toThrow(/workflowOwnerAnchored.enabled requires the driver/)
  })

  it('commits each fresh completed goal passing ONLY a six-key locator plus authority (never a prompt or steps)', async () => {
    const goals = freshGoals(OA_WS, Date.now(), 3)
    const h = await mount({ ownerAnchoredGoals: goals })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true, maxCommitsPerWake: 10 },
    }))
    await runWake(service)

    const track = service.health().ownerAnchored!
    expect(track).toMatchObject({ considered: 3, attempted: 3, recorded: 3, replayed: 0, abstained: 0, stopped: null })
    expect(h.ownerAnchoredCommit).toHaveBeenCalledTimes(3)

    for (const [index, call] of h.ownerAnchoredCommit.mock.calls.entries()) {
      const payload = call[0] as { locator: Record<string, unknown>; authority: unknown }
      // Exactly the six locator keys, all anchored to authority/config — the
      // driver never forwards an objective, raw prompt, tool arguments or a
      // verdict of its own.
      expect(Object.keys(payload.locator).sort()).toEqual(['goalId', 'ownerRouteId', 'preset', 'principalId', 'sessionId', 'workspace'])
      expect(payload.locator).toMatchObject({
        ownerRouteId: OWNER_ROUTE, principalId: PRINCIPAL, workspace: h.root, preset: PRESET,
        sessionId: goals[index]!.native.sessionId, goalId: goals[index]!.id,
      })
      expect(JSON.stringify(payload)).not.toContain('Repeatable')
      expect(payload.authority).toBeDefined()
    }
  })

  it('ignores goals outside the lookback horizon and non-complete goals (coarse prefilter)', async () => {
    const now = Date.now()
    const staleStamp = now - 90_000_000
    const stale = freshGoals(OA_WS, staleStamp, 2).map((record, index) =>
      Object.freeze({ ...record, native: Object.freeze({ ...record.native, updatedAt: staleStamp - index }), updatedAt: staleStamp - index }))
    const pausedBase = freshGoalRecord(OA_WS, 'oa-sess-paused', 'oa-goal-paused', 0, now)
    const paused = Object.freeze({ ...pausedBase, native: Object.freeze({ ...pausedBase.native, phase: 'paused' as const }) })
    const fresh = freshGoals(OA_WS, now, 1)
    const h = await mount({ ownerAnchoredGoals: [...stale, paused, ...fresh] })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    const track = service.health().ownerAnchored!
    expect(track.considered).toBe(1)
    expect(track.attempted).toBe(1)
    expect(h.ownerAnchoredCommit).toHaveBeenCalledTimes(1)
    expect((h.ownerAnchoredCommit.mock.calls[0]![0] as { locator: { goalId: string } }).locator.goalId).toBe('oa-goal-1')
  })

  it('honours maxCommitsPerWake and leaves the rest for a later wake', async () => {
    const h = await mount({ ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 8) })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true, maxCommitsPerWake: 3 },
    }))
    await runWake(service)
    const track = service.health().ownerAnchored!
    expect(track).toMatchObject({ considered: 8, attempted: 3, recorded: 3, stopped: null })
    expect(h.ownerAnchoredCommit).toHaveBeenCalledTimes(3)
  })

  it('counts replays and not-reducible abstains without failing the track', async () => {
    const h = await mount({
      ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 3),
      commitResultById: new Map<string, ScriptedCommitResult>([
        ['oa-goal-2', ABSTAINED],
        ['oa-goal-3', TRACE_REPLAYED],
      ]),
    })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    expect(service.health().ownerAnchored).toMatchObject({
      considered: 3, attempted: 3, recorded: 1, replayed: 1, abstained: 1, stopped: null,
    })
  })

  it('skips a single goal missing its evidence/owner-root binding but keeps scanning the rest', async () => {
    const h = await mount({
      ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 3),
      commitThrowById: new Map([
        ['oa-goal-2', { code: 'missing-binding', message: 'assistant-delivery: no current achieved acceptance receipt' }],
      ]),
    })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    expect(service.health().ownerAnchored).toMatchObject({
      considered: 3, attempted: 3, recorded: 2, abstained: 0, stopped: null,
    })
  })

  it('fails closed and halts the track when Delivery reports the goals runtime unavailable', async () => {
    const h = await mount({
      ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 5),
      commitThrowById: new Map([
        ['oa-goal-1', { code: 'runtime-unavailable', message: 'assistant-delivery: goals run proof unavailable' }],
      ]),
    })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    const track = service.health().ownerAnchored!
    expect(track.attempted).toBe(1)
    expect(track.recorded).toBe(0)
    expect(track.stopped).toEqual(expect.stringMatching(/^runtime-unavailable:/))
    // The first goal halted the track; later goals were never attempted.
    expect(h.ownerAnchoredCommit).toHaveBeenCalledTimes(1)
  })

  it('fails closed and records stopped when goals enumeration itself throws (zero commits)', async () => {
    const h = await mount({ ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 3) })
    h.goalsApi.inspectOwnerGoals.mockImplementation(() => { throw new Error('assistant-goals: service unavailable') })
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    const track = service.health().ownerAnchored!
    expect(track).toMatchObject({ considered: 0, attempted: 0, recorded: 0, stopped: expect.stringMatching(/^inspect:/) })
    expect(h.ownerAnchoredCommit).not.toHaveBeenCalled()
  })

  it('still runs the model-driven skill gate independently after the owner-anchored track stops (no cross-block)', async () => {
    const h = await mount({
      adapter: new ScriptedAdapter(successTurns()),
      ownerAnchoredGoals: freshGoals(OA_WS, Date.now(), 3),
      commitThrowById: new Map([['oa-goal-1', { code: 'policy-denied', message: 'assistant-delivery: authority scope mismatch' }]]),
    })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      budgetId: 'growth-budget', budgetAmount: 1,
      workflowOwnerAnchored: { enabled: true },
    }))
    await runWake(service)
    const health = service.health()
    // Owner-anchored track failed closed ...
    expect(health.ownerAnchored!.stopped).toEqual(expect.stringMatching(/^policy-denied:/))
    // ... yet the independent skill track still ran to its model result.
    expect(health.outcome).toBe('ran')
  })
})


// The control-plane port below is an engineering fixture. It checks the native
// Agent/tool/Policy/Cordis wiring; Docker and checked-plan persistence have
// their own control-plane tests and are not simulated as production evidence.
describe('opt-in plugin source proposals', () => {
  const sourceArgs = { gap_id: 'gap-1', plugin_name: 'assistant-health', files: [{ path: 'README.md', content: 'proposed docs' }] }
  const sourceTurns = [
    { name: 'plugin_source_gaps', args: {} },
    { name: 'plugin_source_read', args: { gap_id: 'gap-1', plugin_name: 'assistant-health', paths: [] } },
    { name: 'plugin_source_read', args: { gap_id: 'gap-1', plugin_name: 'assistant-health', paths: ['README.md'] } },
    { name: 'plugin_source_prepare', args: sourceArgs },
  ]
  const options = (root: string) => ({ enabled: true, repository: root, maxPlansPerWake: 1 })
  function sourceService() {
    return {
      canPrepareSource: () => true,
      inspectSource: vi.fn(async (input: Parameters<GrowthSourcePlanePort['inspectSource']>[0]) => {
        input.signal.throwIfAborted()
        input.assertCurrent()
        return { name: input.name, baseCommit: 'c'.repeat(40),
          files: [{ path: 'README.md', bytes: 8 }, { path: 'src/index.ts', bytes: 8 }],
          contents: input.paths.map(path => ({ path, content: 'original' })),
        }
      }),
      gaps: vi.fn(() => [{ id: 'gap-1', capability: 'health', context: 'owner gap', status: 'open' as const, createdAt: 1 }]),
      prepareModifySourcePlan: vi.fn(async (input: Parameters<GrowthSourcePlanePort['prepareModifySourcePlan']>[0]) => {
        input.signal.throwIfAborted()
        input.assertCurrent()
        return { id: 'pending-source-1', status: 'pending-approval', name: input.name, mode: 'modify', baseCommit: input.expectedBaseCommit,
          sourceCheck: { treeDigest: 'a'.repeat(64), patchDigest: 'b'.repeat(64), checkedAt: 1 } }
      }),
    }
  }

  it('publishes intrinsic service dependencies on the actual default plugin', () => {
    expect(plugin.inject).toEqual(AssistantGrowthDriverService.inject)
    expect(plugin.inject).not.toContain('pluginControlPlane')
  })

  it('rejects missing/noncanonical repository and online preparation config before resources', () => {
    for (const repository of [undefined, '', 'relative', '/a/../b']) {
      expect(() => normalizeConfig(driverConfig('/tmp', { pluginSourceProposals: { enabled: true, repository } }))).toThrow(/repository/)
    }
    expect(() => normalizeConfig(driverConfig('/tmp', { pluginSourceProposals: { ...options('/tmp'), offline: false } }))).toThrow(/offline/)
    expect(() => normalizeConfig(driverConfig('/tmp', { pluginSourceProposals: { ...options('/tmp'), preparationMode: 'later' } }))).toThrow()
  })

  it.each([false, true])('keeps four tools when source enabled=%s but its peer is absent', async enabled => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: { ...options(h.root), enabled } }))
    await service.wake()
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 0 })
    expect(adapter.surfaces[0]).toHaveLength(4)
    expect(adapter.surfaces[0]?.every(name => name.startsWith('growth_'))).toBe(true)
  })

  it('keeps the baseline when the installed source provider has no configured builder', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    h.ctx.provide('pluginControlPlane' as never, { ...sourceService(), canPrepareSource: () => false } as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(adapter.surfaces[0]).toHaveLength(4)
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 0 })
  })

  it('keeps the baseline when durable source enqueue authority is unavailable', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    h.ctx.provide('pluginControlPlane' as never, sourceService() as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      pluginSourceProposals: { ...options(h.root), preparationMode: 'durable' },
    }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(adapter.surfaces[0]).toHaveLength(4)
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 0 })
  })

  it('uses durable source seams after their live authority becomes available without provider reload', async () => {
    const adapter = new ScriptedAdapter(sourceTurns)
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    let available = false
    const source = {
      ...sourceService(), canEnqueueSource: () => available,
      enqueueSourceJob: vi.fn(async (input: Parameters<GrowthSourcePlanePort['enqueueSourceJob']>[0]) => ({
        id: 'late-job', name: input.name, gapId: input.gapId, baseCommit: input.expectedBaseCommit, status: 'queued' as const, createdAt: 1, expiresAt: 2,
      })),
      inspectSourceJob: vi.fn(),
    }
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: { ...options(h.root), preparationMode: 'durable' } }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(adapter.surfaces[0]).toHaveLength(4)
    available = true
    adapter.reset()
    await service.wake()
    expect(adapter.surfaces.at(-1)).toHaveLength(8)
    expect(source.enqueueSourceJob).toHaveBeenCalledTimes(1)
  })

  it('late-binds the optional provider and forwards only frozen Host settings to one pending plan', async () => {
    const adapter = new ScriptedAdapter(sourceTurns)
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    const source = sourceService()
    await h.ctx.plugin({ name: 'source-fixture', apply: ctx => { ctx.provide('pluginControlPlane' as never, source as never) } })
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(service.health().outcome).toBe('ran')
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 1, rejected: 0 })
    expect(adapter.surfaces[0]).toHaveLength(7)
    expect(source.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
    expect(source.prepareModifySourcePlan.mock.calls[0]?.[0]).toMatchObject({
      gapId: 'gap-1', name: 'assistant-health', repository: h.root, files: sourceArgs.files,
      offline: true, ttlMs: 86_400_000, timeoutMs: 180_000, expectedBaseCommit: 'c'.repeat(40),
    })
    expect(source.inspectSource.mock.calls[0]?.[0]).toMatchObject({ repository: h.root, name: 'assistant-health', paths: [] })
    expect(source.inspectSource.mock.calls[0]?.[0].baseCommit).toBeUndefined()
    expect(source.inspectSource.mock.calls[1]?.[0]).toMatchObject({ baseCommit: 'c'.repeat(40), paths: ['README.md'] })
    expect(tableCounts(h)).toEqual({ candidates: 0, definitions: 0, runs: 0 })
  })

  it.each(['inline', 'durable'] as const)('resolves exact edits to full files before %s source preparation', async preparationMode => {
    const turns = [
      sourceTurns[0]!, sourceTurns[1]!,
      { name: 'plugin_source_read', args: { gap_id: 'gap-1', plugin_name: 'assistant-health', paths: ['README.md', 'src/index.ts'] } },
      { name: 'plugin_source_prepare', args: {
        gap_id: 'gap-1', plugin_name: 'assistant-health',
        files: [{ path: 'tests/new.spec.ts', content: 'new test' }],
        edits: [{ path: 'README.md', before: 'original', after: 'resolved readme' }, { path: 'src/index.ts', before: 'original', after: 'resolved source' }],
      } },
    ]
    const h = await mount({ adapter: new ScriptedAdapter(turns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = preparationMode === 'inline' ? sourceService() : {
      ...sourceService(), canEnqueueSource: () => true,
      enqueueSourceJob: vi.fn(async (input: Parameters<GrowthSourcePlanePort['enqueueSourceJob']>[0]) => ({
        id: 'source-job-edits', name: input.name, gapId: input.gapId, baseCommit: input.expectedBaseCommit, status: 'queued' as const, createdAt: 1, expiresAt: 2,
      })), inspectSourceJob: vi.fn(),
    }
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      pluginSourceProposals: { ...options(h.root), preparationMode },
    }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    const call = preparationMode === 'inline'
      ? source.prepareModifySourcePlan.mock.calls[0]?.[0]
      : (source as typeof source & { enqueueSourceJob: ReturnType<typeof vi.fn> }).enqueueSourceJob.mock.calls[0]?.[0]
    expect(call).toMatchObject({ expectedBaseCommit: 'c'.repeat(40), files: [
      { path: 'tests/new.spec.ts', content: 'new test' },
      { path: 'README.md', content: 'resolved readme' },
      { path: 'src/index.ts', content: 'resolved source' },
    ] })
  })

  it('queues a durable source job with frozen owner data and exposes only scoped status', async () => {
    const durableTurns = [...sourceTurns, { name: 'plugin_source_job_status', args: { id: 'source-job-1' } }]
    const adapter = new ScriptedAdapter(durableTurns)
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = {
      ...sourceService(),
      canEnqueueSource: () => true,
      enqueueSourceJob: vi.fn(async (input: Parameters<GrowthSourcePlanePort['enqueueSourceJob']>[0]) => {
        input.signal.throwIfAborted()
        input.assertCurrent()
        return { id: 'source-job-1', name: input.name, gapId: input.gapId, baseCommit: input.expectedBaseCommit,
          status: 'queued' as const, createdAt: 1, expiresAt: 2 }
      }),
      inspectSourceJob: vi.fn((input: Parameters<GrowthSourcePlanePort['inspectSourceJob']>[0]) => ({
        id: input.id, name: 'assistant-health', gapId: 'gap-1', baseCommit: 'c'.repeat(40),
        status: 'queued' as const, createdAt: 1, expiresAt: 2,
      })),
    }
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, {
      pluginSourceProposals: { ...options(h.root), preparationMode: 'durable' },
    }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(service.health().run?.sourceProposals).toEqual({ queued: 1, prepared: 0, rejected: 0 })
    expect(adapter.surfaces[0]).toHaveLength(8)
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
    expect(source.enqueueSourceJob).toHaveBeenCalledWith(expect.objectContaining({
      gapId: 'gap-1', name: 'assistant-health', repository: h.root, expectedBaseCommit: 'c'.repeat(40), ttlMs: 86_400_000,
      owner: { ownerRouteId: OWNER_ROUTE, principalId: PRINCIPAL, principalRecordId: RECORD_ID, principalVersion: 1, workspace: h.root, preset: PRESET },
    }))
    expect(source.enqueueSourceJob.mock.calls[0]?.[0]).not.toHaveProperty('timeoutMs')
    expect(source.inspectSourceJob).toHaveBeenCalledWith({
      id: 'source-job-1',
      owner: { ownerRouteId: OWNER_ROUTE, principalId: PRINCIPAL, principalRecordId: RECORD_ID, principalVersion: 1, workspace: h.root, preset: PRESET },
    })
  })


  it('keeps the four-tool baseline for an older provider without source inspection', async () => {
    const adapter = new ScriptedAdapter([])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    h.ctx.provide('pluginControlPlane' as never, { ...sourceService(), inspectSource: undefined } as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(adapter.surfaces[0]).toHaveLength(4)
  })

  it.each(['no-read', 'manifest-only', 'unread-file'])('rejects preparation without relevant inspected content: %s', async mode => {
    const turns = mode === 'no-read' ? [sourceTurns[0]!, sourceTurns[3]!]
      : mode === 'manifest-only' ? [sourceTurns[0]!, sourceTurns[1]!, sourceTurns[3]!]
        : [...sourceTurns.slice(0, 3), { name: 'plugin_source_prepare', args: { ...sourceArgs, files: [{ path: 'src/index.ts', content: 'replacement' }] } }]
    const h = await mount({ adapter: new ScriptedAdapter(turns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 1 })
  })

  it('does not accept a changed base from a later source read', async () => {
    const h = await mount({ adapter: new ScriptedAdapter(sourceTurns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    let reads = 0
    source.inspectSource.mockImplementation(async input => ({ name: input.name, baseCommit: (++reads === 1 ? 'c' : 'd').repeat(40),
      files: [{ path: 'README.md', bytes: 8 }], contents: input.paths.map(path => ({ path, content: 'original' })) }))
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.inspectSource).toHaveBeenCalledTimes(2)
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
  })

  it('invalidates changed cached content for the rest of the wake even if the Agent tries another read', async () => {
    const reread = { name: 'plugin_source_read', args: { gap_id: 'gap-1', plugin_name: 'assistant-health', paths: ['README.md'] } }
    const turns = [...sourceTurns.slice(0, 3), reread, reread, sourceTurns[3]!]
    const h = await mount({ adapter: new ScriptedAdapter(turns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    let reads = 0
    source.inspectSource.mockImplementation(async input => ({ name: input.name, baseCommit: 'c'.repeat(40),
      files: [{ path: 'README.md', bytes: 8 }], contents: input.paths.map(path => ({ path, content: ++reads > 1 ? 'drifted' : 'original' })) }))
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.inspectSource).toHaveBeenCalledTimes(3)
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 1 })
  })

  it.each(['../secret.ts', '.env', 'lib/index.js', 'src/../../other.ts'])('rejects source read path %s before calling its provider', async path => {
    const h = await mount({ adapter: new ScriptedAdapter([sourceTurns[0]!, { name: 'plugin_source_read',
      args: { gap_id: 'gap-1', plugin_name: 'assistant-health', paths: [path] } }]) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.inspectSource).not.toHaveBeenCalled()
  })

  it('cancels source reads when the optional provider is removed', async () => {
    const h = await mount({ adapter: new ScriptedAdapter(sourceTurns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    let signal: AbortSignal | undefined
    source.inspectSource.mockImplementation(input => new Promise((_resolve, reject) => {
      signal = input.signal
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
    }))
    const provider = h.ctx.plugin({ name: 'source-inspection-fixture', apply: ctx => { ctx.provide('pluginControlPlane' as never, source as never) } })
    await provider
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    const wake = service.wake()
    await vi.waitFor(() => expect(signal).toBeDefined())
    await provider.dispose()
    await wake
    expect(signal?.aborted).toBe(true)
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
  })

  it('caps attempts even after a build rejection and never calls approval/release capabilities', async () => {
    const adapter = new ScriptedAdapter([...sourceTurns, sourceTurns[3]!])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    source.prepareModifySourcePlan.mockRejectedValue(new Error('isolated check failed'))
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 2 })
  })

  it.each(['assistant-policy', 'assistant-skills', '../outside'])('refuses protected/invalid target %s before calling the Host', async plugin_name => {
    const adapter = new ScriptedAdapter([sourceTurns[0]!, { name: 'plugin_source_prepare', args: { ...sourceArgs, plugin_name } }])
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    h.ctx.provide('pluginControlPlane' as never, source as never)
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    await service.wake()
    expect(source.prepareModifySourcePlan).not.toHaveBeenCalled()
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 0, rejected: 1 })
  })

  it('coalesces explicit wakes and cancels on provider replacement before binding the new generation', async () => {
    const adapter = new ScriptedAdapter(sourceTurns)
    const h = await mount({ adapter })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    let observedSignal: AbortSignal | undefined
    source.prepareModifySourcePlan.mockImplementation(input => new Promise((_resolve, reject) => {
      observedSignal = input.signal
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
    }))
    const provider = h.ctx.plugin({ name: 'source-fixture', apply: ctx => { ctx.provide('pluginControlPlane' as never, source as never) } })
    await provider
    const service = new AssistantGrowthDriverService(h.ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    await new Promise(resolve => setImmediate(resolve))
    const first = service.wake()
    expect(service.wake()).toBe(first)
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    await provider.dispose()
    await first
    expect(observedSignal?.aborted).toBe(true)
    expect(source.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
    adapter.reset()
    await service.wake()
    expect(adapter.surfaces.at(-1)).toHaveLength(4)
    const replacement = sourceService()
    await h.ctx.plugin({ name: 'replacement-source-fixture', apply: ctx => { ctx.provide('pluginControlPlane' as never, replacement as never) } })
    await new Promise(resolve => setImmediate(resolve))
    adapter.reset()
    await service.wake()
    expect(adapter.surfaces.at(-1)).toHaveLength(7)
    expect(replacement.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
    expect(source.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
    expect(service.health().run?.sourceProposals).toEqual({ queued: 0, prepared: 1, rejected: 0 })
  })

  it('aborts and drains the active build before the driver Fiber finishes disposal', async () => {
    const h = await mount({ adapter: new ScriptedAdapter(sourceTurns) })
    process.env.SUPER_RELAY_API_KEY = 'test-key'
    const source = sourceService()
    let signal: AbortSignal | undefined
    let settled = false
    source.prepareModifySourcePlan.mockImplementation(input => new Promise((_resolve, reject) => {
      signal = input.signal
      input.signal.addEventListener('abort', () => { settled = true; reject(input.signal.reason) }, { once: true })
    }))
    h.ctx.provide('pluginControlPlane' as never, source as never)
    let service: AssistantGrowthDriverService | undefined
    const driver = h.ctx.plugin({ name: 'owned-growth-driver', apply: ctx => {
      service = new AssistantGrowthDriverService(ctx, driverConfig(h.root, { pluginSourceProposals: options(h.root) }))
    } })
    await driver
    await new Promise(resolve => setImmediate(resolve))
    const wake = service!.wake()
    await vi.waitFor(() => expect(signal).toBeDefined())
    await driver.dispose()
    expect(signal?.aborted).toBe(true)
    expect(settled).toBe(true)
    await wake
    await service!.wake()
    expect(source.prepareModifySourcePlan).toHaveBeenCalledTimes(1)
  })
})
