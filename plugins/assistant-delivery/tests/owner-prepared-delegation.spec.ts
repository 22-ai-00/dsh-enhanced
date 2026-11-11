import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type { DeliverySessionLeases } from '../src/session-lease-runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'owner-chat' }
const ownerText = 'Please publish the independently verified report.'
const objective = 'publish the independently verified report'

interface GoalsModule {
  AssistantGoalsService: new (ctx: Context, config: unknown) => unknown
}
interface VerifierModule {
  AssistantVerifierService: new (ctx: Context, config: unknown) => unknown
  createVerifierAuthorities: (config: unknown) => readonly { id: string; digest: string }[]
}
interface NativeGoalPlugins {
  GoalService: new (ctx: Context) => unknown
  goalRoundDriver: { inject: readonly string[], apply(ctx: Context): void }
}

async function nativeGoalPlugins(): Promise<NativeGoalPlugins> {
  const goalsRequire = createRequire(new URL('../../assistant-goals/package.json', import.meta.url))
  const [goal, driver] = await Promise.all([
    import(pathToFileURL(goalsRequire.resolve('@deepseek-ai/dsh-goal')).href),
    import(pathToFileURL(goalsRequire.resolve('@deepseek-ai/dsh-goal-round-driver')).href),
  ]) as [{ default: NativeGoalPlugins['GoalService'] }, NativeGoalPlugins['goalRoundDriver']]
  return { GoalService: goal.default, goalRoundDriver: { inject: driver.inject, apply: driver.apply } }
}

async function goalsSource(): Promise<GoalsModule> {
  return await import(new URL('../../assistant-goals/src/index.ts', import.meta.url).href) as GoalsModule
}

async function verifierSource(): Promise<VerifierModule> {
  return await import(new URL('../../assistant-verifier/src/index.ts', import.meta.url).href) as VerifierModule
}

function toolCallChunks(id: string, name: string, args: unknown): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] as StreamChunk[]
}
function textStopChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] as StreamChunk[]
}

/**
 * Scripted production-path model. The owner turn is Host-bridged: the real
 * catalog and goal_create tools run in `agent/pre-step` (the same way the
 * production scheduled-goal harness acquires the owner turn), so the sealed
 * goal exists before the owner turn ends. Native goal rounds use this model to
 * write the report artifact and finish.
 */
class DelegationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  #workerPhase = 0
  constructor(private readonly artifactContent: string, private readonly options: { beginAtWorker?: boolean } = {}) { super() }
  override async resolveModel(provider: string, id: string) {
    return { provider, id, name: id, inputModalities: ['text'] as const }
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const round = request.messages.some(message => message.role === 'user'
      && (message.source as { kind?: string } | undefined)?.kind === 'goal')
    for (const chunk of round || this.options.beginAtWorker === true ? this.#worker() : textStopChunks('Owner request acknowledged.')) yield chunk
  }
  #worker(): StreamChunk[] {
    this.#workerPhase += 1
    if (this.#workerPhase === 1) return toolCallChunks('write-report-call', 'write_report', { content: this.artifactContent })
    return textStopChunks('The independently verified report has been written.')
  }
}
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
}

async function harness(options: { artifactContent?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-owner-prepared-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root + '/').href
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  // Goals' round admission and settlement require an exact durable session
  // checkpoint (flush), so mount the real JSONL persistence backend.
  await ctx.loader.create({ name: '@deepseek-ai/dsh-session-persistence-jsonl',
    config: { root: join(root, 'session-logs'), compression: 'none' } })
  await ctx.loader.await()
  // Classified tools still pass the real approval hop in ask mode; answer it
  // deterministically so the fixture exercises execution, not card latency.
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', async () => 'allowed-once' as never, { prepend: true })
  const adapter = new DelegationAdapter(options.artifactContent ?? 'ACCEPT ready\n')
  let releaseAdapter = ctx.llm.registerAdapter(['scripted'], adapter)
  const runnerPath = join(root, 'runner.sh')
  await writeFile(runnerPath, '#!/bin/sh\ngrep -q ACCEPT "$1" && exit 0\nexit 1\n')
  await chmod(runnerPath, 0o755)
  ctx.tools.register(defineTool({
    name: 'write_report',
    description: 'Fixture Host tool: write the independently verified report artifact.',
    parameters: { content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { wrote: { type: 'boolean', required: true } } },
      render: (_args: unknown, value: { wrote: boolean }) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    async execute(args: { content: string }) { await writeFile(join(root, 'report.txt'), args.content); return { wrote: true } },
  }))
  const ownerId = 'lark/bot-1/tenant-a/ou_owner'
  const rule = (name: string) => ({ id: 'owner-' + name, effect: 'allow' as const,
    subject: { kind: 'agent' as const, id: 'primary', workspace: root }, actions: ['execute'],
    resource: { kind: 'tool' as const, id: name }, context: { initiators: ['external' as const] } })
  const goalRule = { id: 'owner-business-goal', effect: 'allow' as const,
    subject: { kind: 'agent' as const, id: 'primary', workspace: root },
    actions: ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', 'pause', 'resume', 'clear'],
    resource: { kind: 'goal' as const, id: 'business-context' }, context: { initiators: ['external' as const] } }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
      resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'confirm', effect: 'allow', subject: { kind: 'external', id: ownerId }, actions: ['pair.confirm', 'ingest'],
      resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: ownerId },
      actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    goalRule, rule('goal_create'), rule('goal_acceptance_catalog'), rule('write_report'),
    // Test-thread inspection happens without an external initiator; keep this
    // read-only rule separate so production goal actions stay initiator-bound.
    { id: 'owner-business-goal-test-inspect', effect: 'allow' as const,
      subject: { kind: 'agent' as const, id: 'primary', workspace: root, principal: ownerId },
      actions: ['inspect', 'observe'], resource: { kind: 'goal' as const, id: 'business-context' } },
  ] })
  const authority = { id: 'owner-route', conversation, principal, workspace: root, agentPreset: 'primary',
    policyRef: 'owner-dm', minimumGeneration: 1 }
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, ownerRoutes: [authority] })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const pairing = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const binding = store.createBinding({ conversation, principal, workspace: root, agentPreset: 'primary',
    sessionId: 'owner-session', policyRef: 'owner-dm' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const sent: unknown[] = []
  await service.registerAdapter({ channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] }, start: async () => {},
    progress: async () => {},
    send: async intent => { sent.push(intent); return { outcome: 'accepted' as const,
      providerMessageId: 'om_' + createHash('sha256').update(intent.idempotencyKey).digest('hex').slice(0, 32) } } })
  const verifier = await verifierSource()
  const verifierPath = join(root, 'verification.sqlite')
  const runnerConfig = { kind: 'runner' as const, id: 'local-runner', executable: runnerPath,
    fixedArgs: [] as string[], timeoutMs: 1_000, maxOutputBytes: 4_096 }
  const verifierConfig = { databasePath: verifierPath, tickIntervalMs: 0, requireAcceptance: true,
    authorities: [runnerConfig], profiles: [] as unknown[] }
  const verifierPlugin = await ctx.plugin(verifier.AssistantVerifierService as never, verifierConfig as never)
  const native = await nativeGoalPlugins()
  await ctx.plugin(native.GoalService as never, {} as never)
  const goals = await goalsSource()
  const goalsConfig = { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true,
    stepMaxDurationMs: 60_000, ownerPreparedAcceptance: true }
  const goalsPlugin = await ctx.plugin(goals.AssistantGoalsService as never, goalsConfig as never)
  const driverPlugin = await ctx.plugin(native.goalRoundDriver as never, {} as never)
  await vi.waitFor(() => {
    const health = ctx.assistantGoals.health()
    expect(health.verifierConnected).toBe(true)
    expect(health.outcomeConnected).toBe(true)
  }, { timeout: 10_000 })
  // Delivery owns this Session, so its production session-lease runtime must
  // hold the execution lease for the hand-driven Agent turns too. Use the real
  // Delivery runtime instance (not a second one over the same store): its hooks
  // are the ones guarding model and tool execution.
  const runtimeLeases = (service as unknown as { nativeWebRuntime?: { leases: DeliverySessionLeases } })
    .nativeWebRuntime?.leases
  if (runtimeLeases === undefined) throw new Error('delivery session lease runtime is unavailable')
  runtimeLeases.open({ kind: 'bound', binding }, new AbortController().signal)
  let attached: Agent | undefined
  const agentHandle = await ctx.agents.create({ sessionId: binding.sessionId as never,
    meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'scripted', model: 'fixture' },
    // Attach to the exact unpublished Agent the registry publishes.
    setup: (agentCtx: Context, preparedAgent: Agent) => {
      attached = preparedAgent
      runtimeLeases.attach(preparedAgent)
      // The Delivery inbound runtime normally binds the external initiator for
      // its owned Session; this hand-driven test turn binds the same platform
      // context so Policy evaluates goal/catalog tool calls exactly as in
      // production.
      const unbind = ctx.assistantPolicy.bindInitiator(preparedAgent, 'external', 'lark/bot-1/tenant-a/ou_owner')
      agentCtx.effect(() => unbind, 'fixture-external-initiator')
    } })
  const agent = agentHandle.agent
  expect(attached).toBe(agent)
  // Approval waterfalls dispatch on the agent scope; answer them deterministically
  // so the fixture exercises real tool execution rather than an unanswered card.
  agent.ctx.on('approval/request', async () => 'allowed-once' as never, { prepend: true })
  const envelopes = new Map<string, { channel: string; account: string; eventId: string; occurredAt: number;
    principal: typeof principal; conversation: typeof conversation; kind: 'text'; text: string }>()
  const claim = async (eventId = 'owner-message', turn = 1, text = ownerText) => {
    let envelope = envelopes.get(eventId)
    if (envelope === undefined) {
      envelope = { channel: principal.channel, account: principal.account, eventId, occurredAt: Date.now(),
        principal, conversation, kind: 'text' as const, text }
      envelopes.set(eventId, envelope)
    }
    const accepted = store.acceptInbound(envelope)
    const inbox = accepted.record
    if (!accepted.duplicate) store.queueInbox(inbox.id, binding.id)
    const claimed = store.claimInbox({ ownerId: 'fixture-' + eventId, leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]
    if (claimed === undefined) return { inbox, claimed: undefined, duplicate: accepted.duplicate }
    ctx.emit('agent/inbox/claimed', { agent, turn, message: createUserMessage({ content: [{ type: 'text' as const, text }],
      source: { kind: 'delivery', channel: principal.channel, account: principal.account, eventId, trust: 'untrusted' } }) })
    const owner = store.getPrincipal(principal)!
    store.bindForegroundTaskExecution({ inboxId: inbox.id, scope: { workspace: root, preset: 'primary' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: Date.now() })
    store.recordForegroundExecutionModelSelection({ inboxId: inbox.id, provider: 'scripted', model: 'fixture' })
    // Host-bridge the real catalog + goal_create inside the current owner turn,
    // before the turn's model request; the tool result then carries the sealed
    // acceptance and the round driver starts only after this turn ends.
    let consumed = false
    const removePreStep = ctx.on('agent/pre-step', async ({ agent: current, signal }, next) => {
      if (consumed || current !== agent || ctx.goals.get(agent) !== undefined
        || service.currentPreferenceTurn(agent) === undefined) return await next()
      consumed = true
      removePreStep()
      const catalogResult = await ctx.tools.execute({ callId: ToolCallId('catalog-' + eventId),
        name: 'goal_acceptance_catalog', agent, signal, arguments: {} })
      expect(catalogResult.isError, JSON.stringify(catalogResult)).not.toBe(true)
      const catalog = JSON.parse(resultText(catalogResult as never)) as {
        authorities: Array<{ id: string; digest: string; kind: string; artifactPath?: string }> }
      const runner = catalog.authorities.find(authority => authority.kind === 'runner'
        && authority.artifactPath === 'workspace-relative')
      if (runner === undefined) throw new Error('acceptance catalog did not expose a local runner authority')
      if (!ownerText.includes(objective)) throw new Error('owner text does not quote the objective verbatim')
      const createdGoal = await ctx.tools.execute({ callId: ToolCallId('goal-create-' + eventId),
        name: 'goal_create', agent, signal, arguments: { objective, max_goal_rounds: 1,
          acceptance: { criteria: [{ id: 'report-ready', kind: 'process-behavior',
            authority: { id: runner.id, digest: runner.digest }, artifactPath: 'report.txt',
            stdin: '', expectedStdout: '', expectedExitCode: 0 }],
          bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 } } } })
      expect(createdGoal.isError, JSON.stringify(createdGoal)).not.toBe(true)
      return await next()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text' as const, text }],
      source: { kind: 'delivery', channel: principal.channel, account: principal.account, eventId, trust: 'untrusted' } }))
    return { inbox, claimed, duplicate: accepted.duplicate }
  }
  const drive = async () => {
    await agent.whenIdle()
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await service.tick()
      await service.whenIdle()
      await agent.whenIdle()
      const outcome = contracts(verifierPath).find(contract => contract.kind === 'goal-outcome')
      if (outcome !== undefined) {
        const status = receiptStatus(verifierPath, outcome.id)
        if (status === 'achieved' || status === 'not-achieved') return { contractId: outcome.id, status }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const native = ctx.goals.get(agent)
    throw new Error('owner-prepared delegation did not reach a verdict: requests=' + String(adapter.requests.length)
      + ' contracts=' + JSON.stringify(contracts(verifierPath)) + ' native=' + JSON.stringify(native)
      + ' events=' + JSON.stringify(agent.session.snapshotEvents().slice(-4)))
  }
  const remount = async () => {
    await goalsPlugin.dispose()
    await driverPlugin.dispose()
    await verifierPlugin.dispose()
    await ctx.plugin(verifier.AssistantVerifierService as never, verifierConfig as never)
    await ctx.plugin(goals.AssistantGoalsService as never, goalsConfig as never)
    const driver = await ctx.plugin(native.goalRoundDriver as never, {} as never)
    await vi.waitFor(() => {
      const health = ctx.assistantGoals.health()
      expect(health.verifierConnected).toBe(true)
      expect(health.outcomeConnected).toBe(true)
    }, { timeout: 10_000 })
    return driver
  }
  const useWorkerAdapter = () => {
    const worker = new DelegationAdapter(options.artifactContent ?? 'ACCEPT ready\n', { beginAtWorker: true })
    releaseAdapter()
    releaseAdapter = ctx.llm.registerAdapter(['scripted'], worker)
    return worker
  }
  return { ctx, root, service, store, adapter, agent, binding, claim, drive, remount, useWorkerAdapter,
    verifierPath, goalsPlugin, sent }
}

function contracts(verifierPath: string): Array<{ id: string; kind: string; profile: string }> {
  const database = new DatabaseSync(verifierPath, { readOnly: true })
  try {
    return (database.prepare('SELECT payload FROM acceptance_contracts').all() as Array<{ payload: string }>)
      .map(row => { const contract = JSON.parse(row.payload) as { id: string; task: { kind: string }; profile: { id: string } }
        return { id: contract.id, kind: contract.task.kind, profile: contract.profile.id } })
  } finally { database.close() }
}

function receiptStatus(verifierPath: string, contractId: string): string | undefined {
  const database = new DatabaseSync(verifierPath, { readOnly: true })
  try {
    const row = database.prepare('SELECT payload FROM acceptance_receipts WHERE contract_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(contractId) as { payload: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.payload) as { objectiveStatus: string }).objectiveStatus
  } finally { database.close() }
}

function tableCount(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try { return (database.prepare('SELECT COUNT(*) AS count FROM ' + table).get() as { count: number }).count } finally { database.close() }
}

// Drives the real Delivery store/lease/Policy/Goals/Verifier composition by hand:
// inbound claim and the owner turn are issued here instead of through Delivery's
// own inbound runtime, so foreground-turn acceptance booking is out of scope.
describe('owner-prepared delegation through the production delivery composition', () => {
  it('runs catalog -> goal_create seal -> real round -> independent achieved verdict', async () => {
    const f = await harness({ artifactContent: 'ACCEPT ready\n' })
    const { claimed } = await f.claim()
    expect(claimed).toBeDefined()
    const outcome = await f.drive()
    expect(outcome.status).toBe('achieved')
    expect(f.ctx.goals.get(f.agent)?.phase).toBe('complete')
    expect(f.adapter.requests.length).toBeGreaterThanOrEqual(3)
    const stored = contracts(f.verifierPath)
    expect(stored.map(contract => contract.kind).sort()).toEqual(['goal-outcome', 'goal-step'])
    expect(stored.every(contract => contract.profile === 'owner-prepared')).toBe(true)
    expect(tableCount(join(f.root, 'goals.sqlite.owner-acceptance'), 'goal_owner_acceptance')).toBe(1)
    expect(await readFile(join(f.root, 'report.txt'), 'utf8')).toBe('ACCEPT ready\n')
  }, 120_000)

  it('does not claim success when the worker artifact does not satisfy the sealed criteria', async () => {
    const f = await harness({ artifactContent: 'REJECT pending\n' })
    await f.claim()
    const outcome = await f.drive()
    expect(outcome.status).toBe('not-achieved')
    expect(f.ctx.goals.get(f.agent)?.phase).not.toBe('complete')
    expect(receiptStatus(f.verifierPath, outcome.contractId)).toBe('not-achieved')
  }, 120_000)

  it('reuses the same sealed outcome contract after remounting the plugins', async () => {
    const f = await harness({ artifactContent: 'ACCEPT ready\n' })
    const paused: { id: string; revision: number }[] = []
    f.ctx.on('goal/changed', ((payload: { agent: Agent; change: { operation: string; ref: { id: string; revision: number } } }) => {
      if (paused.length > 0 || payload.agent !== f.agent || payload.change.operation !== 'create') return
      const current = f.ctx.goals.get(f.agent)
      if (current === undefined) return
      f.ctx.goals.pause(f.agent, { id: current.id, revision: current.revision })
      paused.push({ id: current.id, revision: current.revision + 1 })
    }) as never)
    await f.claim()
    await f.agent.whenIdle()
    await vi.waitFor(() => expect(contracts(f.verifierPath).length).toBeGreaterThanOrEqual(1), { timeout: 30_000 })
    const sealed = contracts(f.verifierPath).find(contract => contract.kind === 'goal-outcome')!
    // The owner turn paused the goal before round 1, so only the outcome seal exists.
    expect(contracts(f.verifierPath)).toHaveLength(1)
    expect(sealed.profile).toBe('owner-prepared')
    await f.remount()
    const worker = f.useWorkerAdapter()
    expect(paused).toHaveLength(1)
    const phase = f.ctx.goals.get(f.agent)
    if (phase === undefined) throw new Error('native goal disappeared across remount')
    f.ctx.goals.resume(f.agent, { id: phase.id, revision: phase.revision })
    const outcome = await f.drive()
    expect(outcome.status).toBe('achieved')
    expect(worker.requests.length).toBeGreaterThanOrEqual(2)
    const after = contracts(f.verifierPath)
    expect(after.filter(contract => contract.kind === 'goal-outcome')).toHaveLength(1)
    expect(after.find(contract => contract.kind === 'goal-outcome')!.id).toBe(sealed.id)
    expect(after.filter(contract => contract.kind === 'goal-step')).toHaveLength(1)
    expect(tableCount(join(f.root, 'goals.sqlite.owner-acceptance'), 'goal_owner_acceptance')).toBe(1)
  }, 180_000)

  it('keeps Delivery idempotency: a duplicate owner event does not create a second goal or seal', async () => {
    const f = await harness({ artifactContent: 'ACCEPT ready\n' })
    const first = await f.claim('duplicate-owner-event')
    expect(first.duplicate).toBe(false)
    const outcome = await f.drive()
    expect(outcome.status).toBe('achieved')
    const second = await f.claim('duplicate-owner-event')
    expect(second.duplicate).toBe(true)
    expect(f.store.claimInbox({ ownerId: 'duplicate-claim', leaseMs: 60_000, limit: 1, maxAttempts: 3 })).toHaveLength(0)
    expect(f.ctx.goals.get(f.agent)).toBeDefined()
    expect(tableCount(join(f.root, 'goals.sqlite'), 'goal_records')).toBe(1)
    expect(tableCount(join(f.root, 'goals.sqlite.owner-acceptance'), 'goal_owner_acceptance')).toBe(1)
    expect(contracts(f.verifierPath).filter(contract => contract.kind === 'goal-outcome')).toHaveLength(1)
  }, 120_000)
})
