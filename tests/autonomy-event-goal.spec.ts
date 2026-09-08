import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type DeliveryAdapter, type InboundEnvelope, type OutboundIntent } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import { EventTriggersService } from '@dsh-enhanced/event-triggers'
import { afterEach, describe, expect, test } from 'vitest'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'event-goal-bot', tenant: 'event-goal-tenant', user: 'event-goal-owner' }
const principalId = 'lark/event-goal-bot/event-goal-tenant/event-goal-owner'
const conversation = { channel: 'lark', account: 'event-goal-bot', tenant: 'event-goal-tenant', kind: 'dm' as const, chat: 'oc-event-goal-owner' }
const objective = 'Resume the original goal after the watched file changes.'
const revisedObjective = `${objective} Revised by the owner.`
const phase = process.env.DSH_EVENT_GOAL_PHASE
const phaseRoot = process.env.DSH_EVENT_GOAL_ROOT
const execFile = promisify(execFileCallback)

class EventGoalModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  writeReportOnNextRequest = false
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.writeReportOnNextRequest && options.tools.some(tool => tool.name === 'event_goal_write_report')) {
      this.writeReportOnNextRequest = false
      const id = ToolCallId(`event-goal-write-${this.requests.length}`)
      const argumentsValue = '{"text":"Event goal report verified"}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'event_goal_write_report', argumentsDelta: argumentsValue }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'event_goal_write_report', arguments: argumentsValue } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Event goal report verified.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function inbound(eventId: string): InboundEnvelope {
  return { channel: 'lark', account: 'event-goal-bot', eventId, occurredAt: Date.now(), principal, conversation, kind: 'text', text: objective }
}

async function nativeGoalPlugins() {
  const require = createRequire(new URL('../plugins/assistant-goals/package.json', import.meta.url))
  const goal = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-goal')).href) as { default: new (ctx: Context) => unknown }
  const tools = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-goal')).href) as { inject: readonly string[], apply: (ctx: Context, config: object) => void }
  const driver = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-goal-round-driver')).href) as { inject: readonly string[], apply: (ctx: Context) => void }
  return { GoalService: goal.default, goalTools: { inject: tools.inject, apply: tools.apply }, goalRoundDriver: { inject: driver.inject, apply: driver.apply } }
}

async function assistantGoalsPlugin() {
  return await import(pathToFileURL(join(process.cwd(), 'plugins/assistant-goals/lib/index.js')).href) as {
    AssistantGoalsService: new (ctx: Context, config: object) => unknown
  }
}

async function open(root: string, options: { provision?: boolean; model?: EventGoalModel; allowSourceWait?: boolean } = {}) {
  const workspace = join(root, 'workspace')
  const watched = join(workspace, 'source.txt')
  await mkdir(workspace, { recursive: true })
  if (options.provision !== false) await writeFile(watched, 'before')
  const ctx = new Context(); contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' }, tools: { mode: 'native' } })
  await ctx.plugin(SessionProjectionRegistry)
  ctx.on('session/created', session => {
    session.append('approval/policy', { policy: 'never' })
    session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = session.append as unknown as (type: string, data: unknown) => unknown
    append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
  })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 })
  ctx.provide('agentPresets' as never, { resolve: async () => ({ id: 'primary' }), mount: async () => ({ id: 'primary' }) } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'event-wake-runs', metric: 'automation-runs', limit: 5, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }], rules: [
    { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:event-goal' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'owner-goal', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['create', 'wait', 'pause', 'edit', 'observe', 'inspect', 'snapshot', 'execute'], resource: { kind: 'goal', id: '*' }, context: { initiators: ['external'] } },
    { id: 'owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: 'owner-goal-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'goal_*' }, context: { initiators: ['external'] } },
    { id: 'background-goal', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['observe', 'inspect', 'snapshot', 'execute'], resource: { kind: 'goal', id: '*' }, context: { initiators: ['background'] } },
    { id: 'owner-wait-tool', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'goal_wait_event' }, context: { initiators: ['external'] } },
    ...(options.allowSourceWait === false ? [] : [{ id: 'source-wait', effect: 'allow' as const, subject: { kind: 'agent' as const, id: 'primary', workspace, principal: principalId }, actions: ['wait-for-event'], resource: { kind: 'automation' as const, id: 'file-report' }, context: { initiators: ['external' as const] } }]),
    { id: 'observe-file', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file' }, actions: ['observe'], resource: { kind: 'filesystem', id: watched }, context: { initiators: ['background'] } },
    { id: 'ingest-event', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:file', workspace }, actions: ['ingest'], resource: { kind: 'automation', id: 'file-report' }, context: { initiators: ['external'] } },
    { id: 'automation', effect: 'allow', subject: { kind: 'background', id: '*', workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'wake', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: principalId }, actions: ['wake'], resource: { kind: 'goal', id: '*' }, context: { initiators: ['background'] } },
    { id: 'wake-result-send', effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ...(options.allowSourceWait === false ? [] : [{ id: 'background-source-wait', effect: 'allow' as const, subject: { kind: 'background' as const, id: 'assistant-goals-wake/v1', workspace, principal: principalId }, actions: ['wait-for-event'], resource: { kind: 'automation' as const, id: 'file-report' }, context: { initiators: ['background' as const] } }]),
    { id: 'background-goal-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'goal_*' }, context: { initiators: ['background'] } },
    { id: 'background-write-result', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'event_goal_write_report' }, context: { initiators: ['background'] } },
  ] })
  const model = options.model ?? new EventGoalModel(); ctx.llm.registerAdapter(['event-goal-model'], model)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register({
    name: 'event_goal_write_report', description: 'Write the independently checked event-goal fixture report.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { written: { type: 'boolean' } }, required: ['written'], additionalProperties: false }, render: () => [] },
    async execute(argumentsValue) {
      const text = (argumentsValue as { text: string }).text
      if (text !== 'Event goal report verified') throw new Error('unexpected fixture report')
      await writeFile(join(workspace, 'report.md'), text)
      return { written: true }
    },
  })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false, defaultWorkspace: workspace, defaultAgentPreset: 'primary', agentProvider: 'event-goal-model', agentModel: 'fixture', ownerRoutes: [{ id: 'event-goal-owner', conversation, principal, workspace, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }] })
  const sends: OutboundIntent[] = []
  const adapter: DeliveryAdapter = { channel: 'lark', account: 'event-goal-bot', capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['markdown'] }, start: async () => {}, send: async intent => { sends.push(intent); return { outcome: 'accepted', providerMessageId: createHash('sha256').update(intent.idempotencyKey).digest('hex') } } }
  await ctx.assistantDelivery.registerAdapter(adapter)
  if (options.provision !== false) {
    const pairing = ctx.assistantDelivery.issuePairing('event-goal', principal)
    ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
    // Establish the persisted owner conversation before installing the Goal
    // bridge; each scenario below starts from a clean owner turn.
    await ctx.assistantDelivery.acceptInbound(inbound('event-goal-bootstrap'))
    await ctx.assistantDelivery.tick(); await ctx.assistantDelivery.whenIdle()
  }
  const delivery = new DatabaseSync(join(root, 'delivery.sqlite'), { readOnly: true })
  const owner = delivery.prepare("SELECT id, version FROM delivery_principals WHERE role = 'owner' AND status = 'active'").get() as { id: string; version: number } | undefined
  const binding = delivery.prepare("SELECT id FROM conversation_bindings WHERE status = 'active'").get() as { id: string } | undefined
  delivery.close(); if (owner === undefined || binding === undefined) throw new Error('persisted owner route was unavailable')
  const native = await nativeGoalPlugins()
  await ctx.plugin(native.GoalService as never, {} as never)
  await ctx.plugin(native.goalTools as never, {} as never)
  await ctx.plugin(native.goalRoundDriver as never, {} as never)
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const authority = { kind: 'document' as const, id: 'report-source', sources: [{ id: 'local', url: 'https://example.invalid/event-goal' }], timeoutMs: 1_000, maxResponseBytes: 4_096 }
  const digest = createVerifierAuthorities({ authorities: [authority] })[0]!.digest
  const verificationProfile = (id: string, taskKind: 'goal-step' | 'goal-outcome', profileObjective = objective) => ({ id, version: 1, scope: { workspace, preset: 'primary' }, owner: { principalRecordId: owner.id, principalVersion: owner.version }, taskKind, objective: profileObjective, validityMs: 60_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: [{ id: 'report', kind: 'document-citations' as const, authority: { id: 'report-source', digest }, artifactPath: 'report.md', requiredText: ['Event goal report verified'], quotes: [] }] })
  await ctx.plugin(AssistantVerifierService, { databasePath: join(root, 'verification.sqlite'), tickIntervalMs: 0, requireAcceptance: false, authorities: [authority], profiles: [verificationProfile('event-goal-step', 'goal-step'), verificationProfile('event-goal-outcome', 'goal-outcome'), verificationProfile('event-goal-step-revised', 'goal-step', revisedObjective), verificationProfile('event-goal-outcome-revised', 'goal-outcome', revisedObjective)] })
  const goals = await assistantGoalsPlugin()
  const goalsFiber = await ctx.plugin(goals.AssistantGoalsService as never, { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true, eventWaits: true, stepMaxDurationMs: 10_000, executionBudget: { modelCalls: 5, toolCalls: 5, inputTokens: 500, outputTokens: 500, durationMs: 60_000, maxOutputTokensPerCall: 128 }, backgroundWake: { ownerRouteId: 'event-goal-owner', budgetId: 'event-wake-runs', maxDelayMs: 30_000, runTimeoutMs: 5_000 } })
  const assistantGoals = (ctx as Context & { assistantGoals: { registerBudgetMeter: (meter: object) => void } }).assistantGoals
  assistantGoals.registerBudgetMeter({ id: 'event-goal-meter', provider: 'event-goal-model', model: 'fixture', inputTokenUpperBound: () => 10, inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null })
  ctx.assistantAutomations.reconcileSystem({ owner: 'event-test', automationId: 'file-report', idempotencyKey: 'file-report-v1', definition: { name: 'Normal file delivery', prompt: 'This ordinary automation remains enabled.', schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z' }, workspace, agentPreset: 'primary', provider: 'event-goal-model', model: 'fixture', allowedTools: [], timeoutMs: 10_000, maxOutputTokens: 128, maxToolCalls: 0, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: principalId, deliveryBindingId: binding.id, budgetId: 'event-wake-runs', budgetAmount: 1 } })
  await ctx.plugin(EventTriggersService, { databasePath: join(root, 'events.sqlite'), allowedFileRoots: [workspace], allowedHttpHosts: [], pollerEnabled: false, triggers: [{ id: 'file', kind: 'file', automationId: 'file-report', path: watched, fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10 }] })
  model.requests.length = 0; sends.length = 0
  return { ctx, goalsFiber, model, workspace, watched, sends }
}

async function drain(ctx: Context) {
  for (let index = 0; index < 4; index += 1) { await ctx.assistantAutomations.tick(); await ctx.assistantAutomations.whenIdle(); await ctx.assistantDelivery.tick(); await ctx.assistantDelivery.whenIdle(); await ctx.assistantGoals.whenIdle() }
}

function readWait(root: string): { state: string; reason: string | null; intent: { source: { highWaterSequence: number }; wake: { native: { revision: number; sessionId: string; goalId: string } } }; wake: { id: string; native: { revision: number; sessionId: string; goalId: string } } | null } {
  const database = new DatabaseSync(join(root, 'goals.sqlite.event-waits'), { readOnly: true })
  try {
    const row = database.prepare('SELECT state, reason, intent_json, wake_json FROM goal_event_waits').get() as { state: string; reason: string | null; intent_json: string; wake_json: string | null } | undefined
    if (row === undefined) throw new Error('event wait was not durable')
    return { state: row.state, reason: row.reason, intent: JSON.parse(row.intent_json), wake: row.wake_json === null ? null : JSON.parse(row.wake_json) }
  } finally { database.close() }
}

function readNative(root: string, goalId: string): { sessionId: string; goalId: string; revision: number; phase: string; roundsStarted: number } {
  const database = new DatabaseSync(join(root, 'goals.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT native_json FROM goal_records WHERE id = ?').get(goalId) as { native_json: string } | undefined
    if (row === undefined) throw new Error('goal record was not durable')
    return JSON.parse(row.native_json)
  } finally { database.close() }
}

async function armWait(fixture: Awaited<ReturnType<typeof open>>, eventId: string): Promise<{ goalId: string; native: ReturnType<typeof readNative> }> {
  let goalId = ''
  const remove = fixture.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (fixture.ctx.assistantDelivery.currentPreferenceTurn(agent) === undefined || goalId !== '') return await next()
    const created = await fixture.ctx.tools.execute({ callId: ToolCallId(`${eventId}-create`), name: 'goal_create', agent, signal, arguments: { objective, max_goal_rounds: 1 } })
    if (created.isError) throw new Error(`goal_create rejected: ${JSON.stringify(created.content)}`)
    const record = fixture.ctx.assistantGoals.list(agent)[0]
    if (record === undefined) throw new Error('goal record was unavailable')
    goalId = record.id
    const waited = await fixture.ctx.tools.execute({ callId: ToolCallId(`${eventId}-wait`), name: 'goal_wait_event', agent, signal, arguments: { goal_id: goalId, expected_revision: record.native.revision, trigger_id: 'file', expires_at: Date.now() + 20_000 } })
    if (waited.isError) throw new Error(`goal_wait_event rejected: ${JSON.stringify(waited.content)}`)
    return await next()
  })
  try { await fixture.ctx.assistantDelivery.acceptInbound(inbound(eventId)); await drain(fixture.ctx) } finally { remove() }
  if (goalId === '') throw new Error('owner turn did not persist an event wait')
  return { goalId, native: readNative(fixture.workspace.slice(0, -'/workspace'.length), goalId) }
}

async function runProcessPhase(root: string, name: 'seed' | 'resume'): Promise<void> {
  const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs')
  await execFile(process.execPath, [vitest, 'run', 'tests/autonomy-event-goal.spec.ts', '-t', `process phase ${name}`], {
    cwd: process.cwd(), timeout: 30_000,
    env: { ...process.env, DSH_EVENT_GOAL_PHASE: name, DSH_EVENT_GOAL_ROOT: root },
  })
}

if (phase === 'seed' || phase === 'resume') describe(`process phase ${phase}`, () => {
  test(`process phase ${phase}`, async () => {
    if (phaseRoot === undefined) throw new Error('process phase root is required')
    if (phase === 'seed') {
      const fixture = await open(phaseRoot)
      const armed = await armWait(fixture, 'process-boundary-seed')
      await fixture.ctx.eventTriggers.pollOnce()
      await writeFile(join(phaseRoot, 'process-seed.json'), JSON.stringify({ pid: process.pid, ...armed }))
      return
    }
    const fixture = await open(phaseRoot, { provision: false })
    fixture.model.writeReportOnNextRequest = true
    const seed = JSON.parse(await readFile(join(phaseRoot, 'process-seed.json'), 'utf8')) as { goalId: string; native: { sessionId: string; goalId: string } }
    await fixture.ctx.eventTriggers.pollOnce(); await writeFile(fixture.watched, 'changed across process boundary')
    await fixture.ctx.eventTriggers.pollOnce(); await drain(fixture.ctx); await drain(fixture.ctx)
    const native = readNative(phaseRoot, seed.goalId)
    if (native.phase !== 'complete' || native.sessionId !== seed.native.sessionId || native.goalId !== seed.native.goalId) throw new Error('resumed native goal identity or completion was incorrect')
    if (await readFile(join(fixture.workspace, 'report.md'), 'utf8') !== 'Event goal report verified') throw new Error('resumed fixture did not write report')
    const verification = new DatabaseSync(join(phaseRoot, 'verification.sqlite'), { readOnly: true })
    const contract = verification.prepare('SELECT id FROM acceptance_contracts').get() as { id: string } | undefined
    verification.close()
    if (contract === undefined || fixture.ctx.assistantVerifier.inspectAcceptedTask(contract.id).receipt?.objectiveStatus !== 'achieved') throw new Error('resumed goal was not independently verified')
    if (!fixture.sends.some(intent => intent.text.includes('Event goal report verified.'))) throw new Error('resumed goal did not produce fixture outbound result')
    await writeFile(join(phaseRoot, 'process-resume.json'), JSON.stringify({ pid: process.pid, native, sends: fixture.sends.length }))
  }, 30_000)
})

afterEach(async () => { await Promise.all([...contexts].map(ctx => ctx.fiber.restart())); contexts.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

if (phase === undefined) describe('native event-goal wake', () => {
  test('a real file event resumes exactly the paused owner Session once and the verifier reads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autonomy-event-goal-')); roots.push(root)
    const fixture = await open(root)
    let goalId = ''; let revision = 0; let ownerAgent: Agent | undefined
    const preSteps: Array<{ human: boolean }> = []
    const remove = fixture.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const human = fixture.ctx.assistantDelivery.currentPreferenceTurn(agent) !== undefined
      preSteps.push({ human })
      if (!human || goalId !== '') return await next()
      ownerAgent = agent
      const created = await fixture.ctx.tools.execute({ callId: ToolCallId('event-goal-create'), name: 'goal_create', agent, signal, arguments: { objective, max_goal_rounds: 1 } })
      expect(created.isError, JSON.stringify(created)).not.toBe(true)
      const record = fixture.ctx.assistantGoals.list(agent)[0]!; goalId = record.id; revision = record.native.revision
      const waited = await fixture.ctx.tools.execute({ callId: ToolCallId('event-goal-wait'), name: 'goal_wait_event', agent, signal, arguments: { goal_id: goalId, expected_revision: revision, trigger_id: 'file', expires_at: Date.now() + 20_000 } })
      expect(waited.isError, JSON.stringify(waited)).not.toBe(true)
      return await next()
    })
    try { await fixture.ctx.assistantDelivery.acceptInbound(inbound('event-goal-owner-turn')); await drain(fixture.ctx) } finally { remove() }
    expect(goalId, JSON.stringify(preSteps)).not.toBe('')
    if (ownerAgent === undefined) throw new Error('owner turn did not reach the native goal tools')
    const waiting = readWait(root)
    expect(waiting).toMatchObject({ state: 'waiting', intent: { source: { highWaterSequence: 0 } } })
    const before = fixture.model.requests.length
    fixture.model.writeReportOnNextRequest = true
    await fixture.ctx.eventTriggers.pollOnce(); await writeFile(fixture.watched, 'changed')
    await fixture.ctx.eventTriggers.pollOnce(); await drain(fixture.ctx)
    // Source notifications materialize the Host-owned wake asynchronously;
    // drain its newly registered at-job before inspecting native state.
    await drain(fixture.ctx)
    const waits = readWait(root)
    expect(['materialized', 'terminal']).toContain(waits.state)
    expect(waits).toMatchObject({ wake: { native: { revision: revision + 1, sessionId: expect.any(String) } } })
    expect(fixture.model.requests).toHaveLength(before + 3)
    const resumedRequests = JSON.stringify(fixture.model.requests.slice(before))
    expect(resumedRequests).toContain('event-triggers:file')
    expect(resumedRequests).not.toContain('changed')
    const wake = waits.wake!
    const nativeAfterWake = readNative(root, goalId)
    const wakeAutomation = fixture.ctx.assistantAutomations.inspectSystemOwned({ owner: 'assistant-goals-wake/v1', automationId: waits.wake === null ? 'missing' : waits.wake.id })
    expect(nativeAfterWake, JSON.stringify({ wait: waits, wakeAutomation })).toMatchObject({ sessionId: wake.native.sessionId, goalId: wake.native.goalId, phase: 'complete', roundsStarted: 1 })
    expect(await readFile(join(fixture.workspace, 'report.md'), 'utf8')).toBe('Event goal report verified')
    const verification = new DatabaseSync(join(root, 'verification.sqlite'), { readOnly: true })
    const contract = verification.prepare('SELECT id FROM acceptance_contracts').get() as { id: string } | undefined
    verification.close(); if (contract === undefined) throw new Error('resumed native goal did not persist a verification contract')
    expect(fixture.ctx.assistantVerifier.inspectAcceptedTask(contract.id)).toMatchObject({ state: 'done', receipt: { objectiveStatus: 'achieved' } })
    expect(fixture.sends).toHaveLength(3)
    expect(fixture.sends).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotencyKey: expect.stringContaining('goal-wake-result:'), text: expect.stringContaining('Event goal report verified.') }),
    ]))
    await fixture.ctx.eventTriggers.pollOnce(); await drain(fixture.ctx)
    expect(fixture.model.requests).toHaveLength(before + 3)
  })

  test('reopens JSONL and durable journals to recover an event observed while the host was stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autonomy-event-goal-restart-')); roots.push(root)
    const first = await open(root)
    let goalId = ''; let revision = 0
    const remove = first.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (first.ctx.assistantDelivery.currentPreferenceTurn(agent) === undefined || goalId !== '') return await next()
      const created = await first.ctx.tools.execute({ callId: ToolCallId('restart-event-create'), name: 'goal_create', agent, signal, arguments: { objective, max_goal_rounds: 1 } })
      expect(created.isError, JSON.stringify(created)).not.toBe(true)
      const record = first.ctx.assistantGoals.list(agent)[0]!; goalId = record.id; revision = record.native.revision
      const waited = await first.ctx.tools.execute({ callId: ToolCallId('restart-event-wait'), name: 'goal_wait_event', agent, signal, arguments: { goal_id: goalId, expected_revision: revision, trigger_id: 'file', expires_at: Date.now() + 20_000 } })
      expect(waited.isError, JSON.stringify(waited)).not.toBe(true)
      return await next()
    })
    try { await first.ctx.assistantDelivery.acceptInbound(inbound('restart-owner-turn')); await drain(first.ctx) } finally { remove() }
    const goals = new DatabaseSync(join(root, 'goals.sqlite'), { readOnly: true })
    const paused = goals.prepare('SELECT native_json FROM goal_records WHERE id = ?').get(goalId) as { native_json: string } | undefined
    goals.close(); if (paused === undefined) throw new Error('paused goal was not durable before shutdown')
    const nativeBefore = JSON.parse(paused.native_json) as { sessionId: string; goalId: string }
    await first.ctx.eventTriggers.pollOnce()
    await first.goalsFiber.dispose()
    // The consumer is genuinely unloaded; EventTriggers remains live and writes
    // the source journal before the process is closed.
    await writeFile(first.watched, 'changed while stopped')
    await first.ctx.eventTriggers.pollOnce()
    await first.ctx.fiber.restart(); contexts.delete(first.ctx)
    first.model.writeReportOnNextRequest = true
    const restarted = await open(root, { provision: false, model: first.model })
    await drain(restarted.ctx)
    const restored = new DatabaseSync(join(root, 'goals.sqlite'), { readOnly: true })
    const row = restored.prepare('SELECT native_json FROM goal_records WHERE id = ?').get(goalId) as { native_json: string } | undefined
    restored.close(); if (row === undefined) throw new Error('reopened goal was not found')
    expect(JSON.parse(row.native_json)).toMatchObject({ sessionId: nativeBefore.sessionId, goalId: nativeBefore.goalId, phase: 'complete', roundsStarted: 1, revision: revision + 4 })
    const wait = new DatabaseSync(join(root, 'goals.sqlite.event-waits'), { readOnly: true })
    const states = wait.prepare('SELECT state FROM goal_event_waits').all() as Array<{ state: string }>
    wait.close(); expect(states).toEqual([{ state: 'materialized' }])
  })

  test('rejects an event wait after a real owner revision change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autonomy-event-goal-revision-')); roots.push(root)
    const fixture = await open(root)
    let goalId = ''; let revision = 0; let ownerAgent: Agent | undefined
    const arm = fixture.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (fixture.ctx.assistantDelivery.currentPreferenceTurn(agent) === undefined || goalId !== '') return await next()
      ownerAgent = agent
      const created = await fixture.ctx.tools.execute({ callId: ToolCallId('revision-event-create'), name: 'goal_create', agent, signal, arguments: { objective, max_goal_rounds: 1 } })
      expect(created.isError, JSON.stringify(created)).not.toBe(true)
      const record = fixture.ctx.assistantGoals.list(agent)[0]!; goalId = record.id; revision = record.native.revision
      const waited = await fixture.ctx.tools.execute({ callId: ToolCallId('revision-event-wait'), name: 'goal_wait_event', agent, signal, arguments: { goal_id: goalId, expected_revision: revision, trigger_id: 'file', expires_at: Date.now() + 20_000 } })
      expect(waited.isError, JSON.stringify(waited)).not.toBe(true)
      return await next()
    })
    try { await fixture.ctx.assistantDelivery.acceptInbound(inbound('revision-owner-create')); await drain(fixture.ctx) } finally { arm() }
    if (ownerAgent === undefined) throw new Error('initial owner turn did not create an event wait')
    let changed = false
    const revise = fixture.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (fixture.ctx.assistantDelivery.currentPreferenceTurn(agent) === undefined || changed) return await next()
      const pausedRevision = readWait(root).intent.wake.native.revision
      const control = await fixture.ctx.tools.execute({ callId: ToolCallId('revision-event-control'), name: 'goal_control', agent, signal, arguments: { goal_id: goalId, expected_revision: pausedRevision, operation: 'edit', objective: revisedObjective } })
      expect(control.isError, JSON.stringify(control)).not.toBe(true); changed = true
      return await next()
    })
    try { await fixture.ctx.assistantDelivery.acceptInbound(inbound('revision-owner-control')); await drain(fixture.ctx) } finally { revise() }
    expect(changed).toBe(true)
    const beforeEvent = fixture.model.requests.length
    await fixture.ctx.eventTriggers.pollOnce(); await writeFile(fixture.watched, 'event after revision')
    await fixture.ctx.eventTriggers.pollOnce(); await drain(fixture.ctx)
    const eventWaits = new DatabaseSync(join(root, 'goals.sqlite.event-waits'), { readOnly: true })
    const wait = eventWaits.prepare('SELECT state, reason FROM goal_event_waits').get() as { state: string; reason: string | null } | undefined
    eventWaits.close(); expect(wait).toEqual({ state: 'terminal', reason: 'invalid-current' })
    // The ordinary automation still receives the event; the stale Goal never resumes.
    expect(fixture.model.requests).toHaveLength(beforeEvent + 1)
  })

  test('crosses a real Node process boundary before resuming the same durable native goal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autonomy-event-goal-process-')); roots.push(root)
    await runProcessPhase(root, 'seed')
    await runProcessPhase(root, 'resume')
    const seed = JSON.parse(await readFile(join(root, 'process-seed.json'), 'utf8')) as { pid: number; goalId: string; native: { sessionId: string; goalId: string } }
    const resumed = JSON.parse(await readFile(join(root, 'process-resume.json'), 'utf8')) as { pid: number; native: { sessionId: string; goalId: string; phase: string }; sends: number }
    expect(resumed.pid).not.toBe(seed.pid)
    expect(resumed.native).toMatchObject({ sessionId: seed.native.sessionId, goalId: seed.native.goalId, phase: 'complete' })
    expect(resumed.sends).toBeGreaterThan(0)
  }, 60_000)

  test('reopening the Host without source-wait authority denies the persisted wait before native resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autonomy-event-goal-policy-revoke-')); roots.push(root)
    const first = await open(root)
    const armed = await armWait(first, 'policy-revoke-seed')
    await first.ctx.eventTriggers.pollOnce()
    await first.ctx.fiber.restart(); contexts.delete(first.ctx)
    const reopened = await open(root, { provision: false, model: first.model, allowSourceWait: false })
    const before = reopened.model.requests.length
    await reopened.ctx.eventTriggers.pollOnce(); await writeFile(reopened.watched, 'event after source wait revocation')
    await reopened.ctx.eventTriggers.pollOnce(); await drain(reopened.ctx); await drain(reopened.ctx)
    expect(readWait(root)).toMatchObject({ state: 'terminal', reason: 'denied' })
    expect(readNative(root, armed.goalId)).toMatchObject({ sessionId: armed.native.sessionId, goalId: armed.native.goalId, phase: 'paused', roundsStarted: 0 })
    expect(reopened.model.requests).toHaveLength(before + 1)
    expect(reopened.sends.some(intent => intent.idempotencyKey.includes('goal-wake-result:'))).toBe(false)
  })
})
