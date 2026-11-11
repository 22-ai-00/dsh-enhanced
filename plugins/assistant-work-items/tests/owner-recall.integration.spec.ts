import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, resolveRetryPolicy, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { Config } from '../src/config.ts'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const reportText = '旧报告🧭：跨会话保留中文与边界🙂。'.repeat(3)
const diagnosisTools = ['work_item_claim', 'work_item_read_report', 'work_item_read_source', 'work_item_report', 'work_item_status']
type Command = { name: string; args: Record<string, unknown> }
type Page = { item: { itemId: string }; content: { text: string; fullBytes: number; returnedBytes: number; offset: number; nextOffset?: number }; reports: Array<{ revision: number }>; reportsTotal: number }
async function* chunks(command?: Command): AsyncIterable<StreamChunk> {
  if (command) {
    const id = ToolCallId(crypto.randomUUID()), args = JSON.stringify(command.args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: command.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: command.name, arguments: args } }
  } else {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Done.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
  }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
  yield { type: 'finish', reason: { kind: command ? 'tool-calls' : 'stop' } }
}
class LocalSupplier extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly plans = new Map<string, Array<Command | undefined>>()
  readonly counts = new Map<string, number>()
  backgroundRead = false
  itemId: string | undefined
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'owner recall fixture') }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text'] as const } }
  override async *stream(request: GenerateOptions) {
    this.requests.push(request); if (this.requests.length > 128) throw new Error('finite scripted supplier cap')
    const id = String(request.sessionId)
    if (id === 'ordinary-source') throw new Error('local foreground failure for real diagnosis intake')
    const plan = this.plans.get(id)
    if (plan) { yield* chunks(plan.shift()); return }
    const count = (this.counts.get(id) ?? 0) + 1; this.counts.set(id, count)
    if (count === 1) yield* chunks({ name: 'work_item_claim', args: {} })
    else if (count === 2) yield* chunks({ name: 'work_item_read_source', args: { offset: 0, max_bytes: 512 } })
    else if (count === 3) yield* chunks({ name: 'work_item_report', args: { status: 'ready', summary: reportText } })
    else if (count === 4 && this.backgroundRead) {
      const claim = request.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('Claimed work item'))
      const actualItem = decoded<{ itemId: string }>(claim!.content).itemId
      yield* chunks({ name: 'work_item_recall', args: { item_id: actualItem } })
    }
    else yield* chunks()
  }
}
function query(path: string, sql: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all() } finally { db.close() }
}
function ledger(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
      const name = String(row['name']); if (!/^[a-z_]+$/u.test(name)) throw new Error('unexpected fixture table name')
      return { name, rows: db.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
    })
  } finally { db.close() }
}
function decoded<T>(content: readonly { type: string; text?: string }[]): T {
  const text = content.map(c => c.text ?? '').join('\n').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T
}
async function fixture(backgroundRead = false) {
  const root = await mkdtemp(join(tmpdir(), 'owner-recall-native-'))
  const ctx = new Context(), agents: Agent[] = [], supplier = new LocalSupplier(); supplier.backgroundRead = backgroundRead
  let operator: DeliveryStore | undefined, access: ReturnType<AssistantDeliveryService['bindNativeWebOwner']> | undefined
  closes.push(async () => { try { await access?.dispose(); await ctx.fiber.dispose() } finally { operator?.close(); await rm(root, { recursive: true, force: true }) } })
  ctx.baseUrl = pathToFileURL(`${root}/`).href
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } }); await ctx.loader.await()
  const dep = createRequire(new URL('../../assistant-delivery/package.json', import.meta.url))
  const Presets = await import(pathToFileURL(dep.resolve('@deepseek-ai/dsh-agent-preset-registry')).href)
  await ctx.plugin(Presets.default as never, { default: 'primary' } as never).await()
  const presets = ctx.get('agentPresets' as never) as unknown as { register(input: { id: string; plugins: unknown[] }): Promise<() => void> }
  await presets.register({ id: 'primary', plugins: [] })
  const principal = { channel: 'web', account: 'browser', tenant: 'local', user: 'owner' }, principalId = 'web/browser/local/owner'
  const conversation = { channel: 'web', account: 'browser', tenant: 'local', kind: 'dm' as const, chat: 'ordinary-source' }
  const scope = { authorityId: 'recall-owner', principalId, workspace: root, agentPreset: 'primary' }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0,
    budgets: [{ id: 'diagnosis-runs', metric: 'automation-runs', limit: 2, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' }], rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'intake', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'install', effect: 'allow', subject: { kind: 'background', id: 'assistant-work-items-diagnosis', workspace: root, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'worker', effect: 'allow', subject: { kind: 'background', id: 'diagnosis-worker', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'work_item_*' }, context: { initiators: ['external', 'background'] } },
      { id: 'owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'recall', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['inspect-work-items'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['external'] } },
      { id: 'send', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ] }).await()
  const Approval = await import(pathToFileURL(dep.resolve('@deepseek-ai/dsh-user-approval')).href)
  await ctx.plugin(Approval.default as never, { policy: 'ask' } as never).await()
  let recallApprovalAsks = 0
  ctx.on('approval/request', (request, next) => { if (['work_item_list', 'work_item_recall'].includes(request.toolName)) recallApprovalAsks++; return next() }, { prepend: true })
  ctx.llm.registerAdapter(['local'], supplier)
  ctx.on('agent/created', ({ agent }) => { agents.push(agent) })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    defaultWorkspace: root, defaultAgentPreset: 'primary', agentProvider: 'local', agentModel: 'scripted', agentMaxAutoContinuationTurns: 0,
    ownerRoutes: [{ id: scope.authorityId, conversation, principal, workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }] }).await()
  operator = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
  const pairing = ctx.assistantDelivery.issuePairing('test', principal); ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  access = ctx.assistantDelivery.bindNativeWebOwner(ctx, { principal, workspace: root, preset: 'primary', maxExecutionMs: 30000 })
  const source = await access.create({ sessionId: 'ordinary-source' as SessionId, meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'local', model: 'scripted' } })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: true, tickIntervalMs: 1000, reconcileIntervalMs: 0 }).await()
  // One clock read: two Date.now() calls can straddle a millisecond and make the diagnosis
  // expiry later than the owner scope, which config validation rejects.
  const expiry = Date.now() + 3600000
  const workConfig: Config & { ownerRecall: { enabled: true } } = { enabled: true, mode: 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'), workerAutomationId: 'diagnosis-worker',
    scope: { workspace: root, preset: 'primary', principalId, ownerRouteId: scope.authorityId, expiresAt: expiry }, ownerRecall: { enabled: true },
    admission: { allowedKinds: ['diagnosis'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 }, limits: { maxReportBytes: 8192 },
    sources: { foregroundFailures: { enabled: true, kind: 'diagnosis', includeTimedOut: true, sweepIntervalMs: 60000, maxCandidatesPerSweep: 10, maxAdmitsPerSweep: 1 } },
    diagnosis: { enabled: true, budgetId: 'diagnosis-runs', budgetAmount: 1, maxModelCalls: 5, maxToolCalls: 4, maxOutputTokens: 512, timeoutMs: 15000, expiresAt: expiry } }
  await ctx.plugin(AssistantWorkItemsService, workConfig).await()
  expect(ctx.tools.schemas().map(t => t.name)).toEqual(expect.arrayContaining(['work_item_list', 'work_item_recall']))
  const authObservations: unknown[] = []
  ctx.on('tools/pre-execute', (execution, next) => {
    const agent = execution.agent
    if (agent && ['work_item_list', 'work_item_recall'].includes(execution.name)) {
      const delivery = ctx.assistantDelivery
      authObservations.push({ deliveryGetIdentityStable: ctx.get('assistantDelivery') === ctx.get('assistantDelivery'), policyGetIdentityStable: ctx.get('assistantPolicy') === ctx.get('assistantPolicy'), signalAborted: execution.signal.aborted, name: execution.name, callIdType: typeof execution.callId, route: delivery.validateOwnerAgentForRoute(agent, scope.authorityId),
        turn: delivery.currentPreferenceTurn(agent), proof: delivery.inspectOwnerForegroundToolCall({ agent, authorityId: scope.authorityId, callId: String(execution.callId), toolName: execution.name, argumentsJson: JSON.stringify(execution.arguments) }),
        policy: ctx.assistantPolicy.evaluateAgent(agent, 'inspect-work-items', { kind: 'automation', id: 'diagnosis-worker' }) })
    }
    return next()
  }, { prepend: true })
  const snapshot = () => ({ workItems: ledger(join(root, 'items.sqlite')), runs: query(join(root, 'automations.sqlite'), 'SELECT * FROM automation_runs ORDER BY id'), budget: query(join(root, 'policy.sqlite'), 'SELECT * FROM budget_reservations ORDER BY id') })
  const produce = async () => {
    await access!.prompt({ sessionId: 'ordinary-source', requestId: 'source-failure', text: 'Inspect the owner task 🧭.', content: [{ type: 'text', text: 'Inspect the owner task 🧭.' }] }, async () => { source.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the owner task 🧭.' }], source: { kind: 'user', rpcId: 'source-failure' as never } })) }, new AbortController().signal)
    await vi.waitFor(() => expect(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item')).toHaveLength(1), { timeout: 5000 })
    supplier.itemId = String(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item')[0]!['id'])
    await vi.waitFor(() => expect(query(join(root, 'automations.sqlite'), 'SELECT status FROM automation_runs')).toHaveLength(1), { timeout: 20000 })
    await ctx.assistantAutomations.whenIdle()
    if (!backgroundRead) expect(query(join(root, 'items.sqlite'), 'SELECT state,attempt FROM work_item')).toEqual([expect.objectContaining({ state: 'ready', attempt: 1 })])
    return supplier.itemId
  }
  const newSession = async () => {
    const before = ctx.assistantDelivery.validateOwnerRoute(scope)
    await ctx.assistantDelivery.acceptInbound({ channel: 'web', account: 'browser', eventId: 'owner-real-new', occurredAt: Date.now(), principal, conversation, kind: 'command', text: '/new' })
    await ctx.assistantDelivery.tick(); await ctx.assistantDelivery.whenIdle()
    const binding = operator!.getActiveBinding(conversation)!
    expect(binding.sessionId).not.toBe('ordinary-source'); expect(binding.generation).toBeGreaterThan(before.generation)
    expect(ctx.assistantDelivery.validateOwnerRoute(scope).generation).toBe(binding.generation)
    return binding.sessionId
  }
  const ask = async (sessionId: string, command: Command) => {
    supplier.plans.set(sessionId, [command, undefined])
    const handle = await access!.resume({ resumeSessionId: sessionId as SessionId, agentOptions: { provider: 'local', model: 'scripted' } })
    const requestId = crypto.randomUUID(), content = [{ type: 'text' as const, text: 'Read my durable background task history.' }]
    try {
      return await access!.prompt({ sessionId, requestId, text: content[0]!.text, content }, async () => {
        handle.agent.followup(createUserMessage({ content, source: { kind: 'user', rpcId: requestId as never } }))
        await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session)
        return handle.agent.session.snapshotEvents().filter(e => e.type === 'tool/result').at(-1)!.data.message
      }, new AbortController().signal)
    } finally { await handle.dispose() }
  }
  return { ctx, supplier, agents, operator, principal, scope, produce, newSession, ask, snapshot, root, authObservations, recallApprovalAsks: () => recallApprovalAsks }
}

describe('real foreground owner work-item recall', () => {
  test('a real /new generation lists the old item and reads its old report as UTF-8 pages without spending work', async () => {
    const f = await fixture(), itemId = await f.produce(), sessionId = await f.newSession(), before = f.snapshot()
    const listed = await f.ask(sessionId, { name: 'work_item_list', args: { limit: 10 } }); expect(listed.isError, JSON.stringify({ content: listed.content, auth: f.authObservations })).toBe(false)
    expect(decoded<{ items: Array<{ itemId: string }> }>(listed.content).items.map(i => i.itemId)).toContain(itemId)
    const brief = await f.ask(sessionId, { name: 'work_item_recall', args: { item_id: itemId } }); expect(brief.isError).toBe(false)
    const view = decoded<Page>(brief.content); expect(view.item.itemId).toBe(itemId); expect(view.reportsTotal).toBe(1)
    let offset = 0, recalled = '', pages = 0
    for (;;) {
      const result = await f.ask(sessionId, { name: 'work_item_recall', args: { max_bytes: pages === 0 ? 7 : 31, item_id: itemId, offset, report_revision: view.reports[0]!.revision } })
      expect(result.isError).toBe(false)
      const page = decoded<Page>(result.content).content
      expect(page.offset).toBe(offset); expect(page.returnedBytes).toBe(Buffer.byteLength(page.text)); expect(page.text).not.toContain('\uFFFD')
      expect(page.returnedBytes).toBeLessThanOrEqual(pages === 0 ? 7 : 31); recalled += page.text; pages++
      if (page.nextOffset === undefined) break
      expect(page.nextOffset).toBe(offset + page.returnedBytes); offset = page.nextOffset
      expect(pages).toBeLessThan(30)
    }
    expect(pages).toBeGreaterThan(1); expect(recalled).toBe(reportText)
    const recalledAgent = f.agents.findLast(agent => String(agent.session.id) === sessionId)!
    const firstPageCall = recalledAgent.session.snapshotEvents().filter(e => e.type === 'tool/call').find(e => e.data.name === 'work_item_recall' && e.data.arguments.includes('"max_bytes":7'))!
    expect(Object.keys(JSON.parse(firstPageCall.data.arguments))).toEqual(['max_bytes', 'item_id', 'offset', 'report_revision'])
    for (const observed of f.authObservations) expect(observed).toMatchObject({ callIdType: 'string', signalAborted: false, turn: { sessionId }, proof: { protocol: 'assistant-delivery/foreground-tool-call/v1', task: { sessionId } } })
    expect(f.snapshot()).toEqual(before)
    expect(f.recallApprovalAsks()).toBe(0)
    for (const request of f.supplier.requests.filter(r => f.supplier.counts.has(String(r.sessionId)))) expect(request.tools?.map(t => t.name).sort()).toEqual(diagnosisTools)
  }, 45000)

  test('an unbound native Agent and a revoked owner cannot read a known historical id', async () => {
    const f = await fixture(), itemId = await f.produce(), sessionId = await f.newSession(), before = f.snapshot()
    const id = 'unbound-reader' as SessionId; f.supplier.plans.set(id, [{ name: 'work_item_recall', args: { item_id: itemId } }, undefined])
    const attacker: AgentHandle = await f.ctx.agents.create({ sessionId: id, meta: { cwd: f.root, agentPreset: 'primary' }, agentOptions: { provider: 'local', model: 'scripted' } })
    try {
      attacker.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read this known item.' }], source: { kind: 'user' } }))
      await attacker.agent.whenIdle()
      const events = attacker.agent.session.snapshotEvents(), call = events.filter(e => e.type === 'tool/call').find(e => e.data.name === 'work_item_recall')!
      expect(JSON.parse(call.data.arguments)).toEqual({ item_id: itemId })
      const result = events.filter(e => e.type === 'tool/result').find(e => String(e.data.message.source.callId) === String(call.data.callId))!.data.message
      // Missing real owner/turn proof prevents preauthorization; UserApproval refuses without a channel.
      expect(result.content).toEqual([{ type: 'text', text: 'Error: tool "work_item_recall" requires approval, but no approval channel is available' }]); expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(reportText)
    } finally { await attacker.dispose() }
    const owner = f.operator!.getPrincipal(f.principal)!; f.operator!.revokePrincipal(owner.id, owner.version)
    expect(f.operator!.getPrincipal(f.principal)).toMatchObject({ status: 'revoked', version: owner.version + 1 })
    await expect(f.ask(sessionId, { name: 'work_item_recall', args: { item_id: itemId } })).rejects.toMatchObject({ kind: 'denied', message: 'assistant-delivery: session execution denied' })
    expect(f.snapshot()).toEqual(before)
  }, 45000)

  test('the real background worker cannot gain foreground recall by emitting its known item id', async () => {
    const f = await fixture(true); await f.produce()
    const worker = f.agents.find(agent => String(agent.session.id) !== 'ordinary-source')!
    const requests = f.supplier.requests.filter(r => String(r.sessionId) === String(worker.session.id))
    expect(requests.length).toBeGreaterThanOrEqual(2)
    for (const request of requests) expect(request.tools?.map(t => t.name).sort()).toEqual(diagnosisTools)
    const events = worker.session.snapshotEvents(), calls = events.filter(e => e.type === 'tool/call'), results = events.filter(e => e.type === 'tool/result')
    const claim = calls.find(e => e.data.name === 'work_item_claim')!, report = calls.find(e => e.data.name === 'work_item_report')!, recall = calls.find(e => e.data.name === 'work_item_recall')!
    expect(claim).toBeDefined(); expect(report).toBeDefined(); expect(recall).toBeDefined()
    const claimResult = results.find(e => String(e.data.message.source.callId) === String(claim.data.callId))!
    const reportResult = results.find(e => String(e.data.message.source.callId) === String(report.data.callId))!
    const recallResult = results.find(e => String(e.data.message.source.callId) === String(recall.data.callId))!
    expect(claimResult.data.message.isError).toBe(false); expect(decoded<{ itemId: string }>(claimResult.data.message.content).itemId).toBe(f.supplier.itemId)
    expect(reportResult.data.message.isError).toBe(false); expect(reportResult.seq).toBeLessThan(recall.seq)
    expect(JSON.parse(recall.data.arguments)).toEqual({ item_id: f.supplier.itemId })
    // The background contract stays at five tools; this forged emission receives no owner preauthorization.
    // The observed rejection occurs in UserApproval, before the WorkItems read handler.
    expect(recallResult.data.message.content).toEqual([{ type: 'text', text: 'Error: tool "work_item_recall" requires approval, but no approval channel is available' }]); expect(recallResult.data.message.isError).toBe(true)
    expect(JSON.stringify(recallResult.data.message)).not.toContain(reportText)

  }, 45000)
})
