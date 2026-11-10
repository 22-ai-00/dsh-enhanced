import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, resolveRetryPolicy, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { Config } from '../src/config.ts'

const closes: Array<() => Promise<void>> = []
const supplierObservations: unknown[]=[]
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks();if(process.env['WORK_ITEM_CONTINUATION_EVIDENCE']) await writeFile(process.env['WORK_ITEM_CONTINUATION_EVIDENCE'],JSON.stringify(supplierObservations,null,2)+'\n') } })
const reportText = '旧报告🧭：跨会话保留中文与边界🙂。'.repeat(40)
const continuationTools = ['work_item_claim', 'work_item_read_context', 'work_item_report']
const callbackAssertions: unknown[] = []
function capture(error: unknown) { if (error instanceof Error && error.name === 'AssertionError') callbackAssertions.push(error) }
afterEach(() => { expect(callbackAssertions.splice(0)).toEqual([]) })
type Command = { name: string; args: Record<string, unknown> }
async function* chunks(command?: Command | Command[]): AsyncIterable<StreamChunk> {
  if (command) {
    for (const [index, call] of (Array.isArray(command)?command:[command]).entries()) {
      const id=ToolCallId(crypto.randomUUID()),args=JSON.stringify(call.args)
      yield {type:'block-start',index,blockType:'tool-call'}
      yield {type:'tool-call-delta',index,id,name:call.name,argumentsDelta:args}
      yield {type:'block-end',index,block:{type:'tool-call',id,name:call.name,arguments:args}}
    }
  } else {
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:'Done.'}
    yield {type:'block-end',index:0,block:{type:'text',text:'Done.'}}
  }
  yield {type:'usage',usage:{inputTokens:10,outputTokens:4}}
  yield {type:'finish',reason:{kind:command?'tool-calls':'stop'}}
}
type ContextPage = { itemId: string; parentItemId: string; rootItemId: string; kind: string; text: string; offset: number; returnedBytes: number; nextOffset?: number }
class LocalSupplier extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly plans = new Map<string, Array<Command | undefined>>()
  readonly counts = new Map<string, number>()
  readonly pages = new Map<string, ContextPage[]>()
  readonly stages = new Map<string, { kind: number; offset: number; last?: Command | undefined; reported?: boolean; attacked?: boolean; artifactWritten?: boolean }>()
  writeAcceptanceArtifact = false
  beforeContinuationPrompt?: () => void
  groupedResponse = false
  markerAttack = false
  summaryGate: Promise<void> | undefined
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'owner continuation offline fixture') }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text'] as const } }
  override async *stream(request: GenerateOptions) {
    try { yield* this.script(request) } catch(error) { capture(error); throw error }
  }
  private async *script(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request); if(this.requests.length>512) throw new Error('finite scripted supplier cap')
    const id=String(request.sessionId)
    if(id==='ordinary-source') throw new Error('offline foreground failure for actual diagnosis intake')
    const foreground=this.plans.get(id)
    if(foreground) { yield* chunks(foreground.shift()); return }
    const count=(this.counts.get(id)??0)+1;this.counts.set(id,count)
    if(!request.tools?.some(tool=>tool.name==='work_item_read_context')) {
      const readsSource = request.tools?.some(tool=>tool.name==='work_item_read_source')
      if(count===1) yield* chunks({name:'work_item_claim',args:{}})
      else if(count===2 && readsSource) yield* chunks({name:'work_item_read_source',args:{offset:0,max_bytes:512}})
      else if(count===(readsSource ? 3 : 2)) yield* chunks({name:'work_item_report',args:{status:'ready',summary:reportText}})
      else { await this.summaryGate; yield* chunks() }
      return
    }
    const stage=this.stages.get(id)??{kind:0,offset:0};this.stages.set(id,stage)
    if(count===1) {this.beforeContinuationPrompt?.();yield* chunks({name:'work_item_claim',args:{}});return}
    if(stage.last?.name==='work_item_read_context') {
      const result=request.messages.filter(message=>message.role==='tool').at(-1)
      if(!result) throw new Error('actual context result missing')
      const page=decoded<ContextPage>(result.content)
      const pages=this.pages.get(id)??[];pages.push(page);this.pages.set(id,pages)
      if(page.nextOffset!==undefined) stage.offset=page.nextOffset
      else {stage.kind++;stage.offset=0}
    }
    const kinds=['input','parent-brief','parent-report']
    let command: Command | undefined
    if(stage.kind<kinds.length) command={name:'work_item_read_context',args:{kind:kinds[stage.kind],offset:stage.offset,max_bytes:512}}
    else if(this.writeAcceptanceArtifact && !stage.artifactWritten) {command={name:'continuation_write_fixture',args:{}};stage.artifactWritten=true}
    else if(!stage.reported) {command={name:'work_item_report',args:{status:'ready',summary:'Continued from current owner input and bounded historical pages.'}};stage.reported=true}
    if(stage.reported && !command && this.markerAttack && !stage.attacked) {command={name:'continuation_marker',args:{}};stage.attacked=true}
    stage.last=command
    if(command?.name==='work_item_report'&&this.groupedResponse) {stage.attacked=true;yield* chunks([command,{name:'continuation_marker',args:{}}]);return}
    yield* chunks(command)
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
async function fixture(options: { holdSummary?: boolean; holdDispose?: boolean; markerAttack?: boolean; groupedResponse?: boolean; genericParent?: boolean; acceptanceArtifact?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'owner-continuation-native-'))
  const ctx = new Context(), agents: Agent[] = [], supplier = new LocalSupplier(); supplier.markerAttack=options.markerAttack===true;supplier.groupedResponse=options.groupedResponse===true
  let releaseSummary: (() => void) | undefined
  if(options.holdSummary) supplier.summaryGate=new Promise<void>(resolve=>{releaseSummary=resolve})
  let operator: DeliveryStore | undefined, access: ReturnType<AssistantDeliveryService['bindNativeWebOwner']> | undefined
  closes.push(async () => { supplierObservations.push({test:expect.getState().currentTestName,requests:supplier.requests.map(request=>({sessionId:String(request.sessionId),provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort})),network:'none: local scripted LlmAdapter only'});try { releaseSummary?.(); releaseDispose?.(); await access?.dispose(); await ctx.fiber.dispose() } finally { operator?.close(); await rm(root, { recursive: true, force: true }) } })
  const warnings: unknown[]=[];ctx.logger.exporter({levels:{default:3},export:message=>{if(message.type==='warn'||message.type==='error')warnings.push(message.args)}})
  let releaseDispose: (() => void) | undefined
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
  const workerId = options.genericParent ? 'ordinary-worker' : 'diagnosis-worker'
  const workerOwner = options.genericParent ? 'ordinary-parent-fixture' : 'assistant-work-items-diagnosis'
  const workerBudget = options.genericParent ? 'ordinary-runs' : 'diagnosis-runs'
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0,
    budgets: [workerBudget,'continuation-runs'].map(id=>({id, metric: 'automation-runs', limit: 5, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' as const})), rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'intake', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: workerId } },
      { id: 'event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: workerId } },
      { id: 'install', effect: 'allow', subject: { kind: 'background', id: workerOwner, workspace: root, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: workerId }, context: { initiators: ['background'] } },
      { id: 'worker', effect: 'allow', subject: { kind: 'background', id: workerId, workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: workerId }, context: { initiators: ['background'] } },
      { id: 'tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'work_item_*' }, context: { initiators: ['external', 'background'] } },
      ...(options.genericParent ? ['work_item_claim', 'work_item_report'].map(tool => ({
        id: `ordinary-parent-${tool}`, effect: 'allow' as const, subject: { kind: 'agent' as const, id: 'primary', workspace: root },
        actions: ['execute'], resource: { kind: 'tool' as const, id: tool }, context: { initiators: ['background' as const] },
      })) : []),
      { id: 'marker', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'continuation_marker' }, context: { initiators: ['background'] } },
      ...(options.acceptanceArtifact === undefined ? [] : [{ id: 'acceptance-fixture-tool', effect: 'allow' as const, subject: { kind: 'agent' as const, id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool' as const, id: 'continuation_write_fixture' }, context: { initiators: ['background' as const] } }]),
      { id: 'owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'recall', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['inspect-work-items'], resource: { kind: 'automation', id: workerId }, context: { initiators: ['external'] } },
      { id: 'continue-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['continue-work-items'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['external'] } },
      { id: 'continue-admit', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'continue-event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'continuation-worker' } },
      { id: 'continue-install', effect: 'allow', subject: { kind: 'background', id: 'assistant-work-items-continuation', workspace: root, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'continue-worker', effect: 'allow', subject: { kind: 'background', id: 'continuation-worker', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'send', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ] }).await()
  const Approval = await import(pathToFileURL(dep.resolve('@deepseek-ai/dsh-user-approval')).href)
  await ctx.plugin(Approval.default as never, { policy: 'ask' } as never).await()
  let recallApprovalAsks = 0
  ctx.on('approval/request', (request, next) => {
    if (['work_item_list', 'work_item_recall', 'work_item_continue'].includes(request.toolName)) recallApprovalAsks++
    if (options.acceptanceArtifact !== undefined && request.toolName === 'continuation_write_fixture' && request.callId !== undefined) {
      const agent = request.agent
      const execution = agent.ctx.get('assistantAutomationExecution')
      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call'
        && String(event.data.callId) === String(request.callId) && event.data.name === request.toolName)
      if (execution?.mode === 'production' && execution.automationId === 'continuation-worker'
        && call?.type === 'tool/call' && call.data.arguments === '{}'
        && ctx.assistantPolicy.evaluateAgent(agent, 'execute', { kind: 'tool', id: request.toolName }).ruleId === 'acceptance-fixture-tool'
        && query(join(root, 'items.sqlite'), "SELECT occurrence_id FROM work_item WHERE kind='owner-continuation'")
          .some(row => row.occurrence_id === execution.occurrenceId)) return Promise.resolve('allowed-once' as const)
    }
    return next()
  }, { prepend: true })
  ctx.llm.registerAdapter(['local','replacement'], supplier)
  ctx.on('agent/created', ({ agent }) => { agents.push(agent) })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    defaultWorkspace: root, defaultAgentPreset: 'primary', agentProvider: 'local', agentModel: 'scripted', agentMaxAutoContinuationTurns: 0,
    ownerRoutes: [{ id: scope.authorityId, conversation, principal, workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }] }).await()
  operator = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
  const pairing = ctx.assistantDelivery.issuePairing('test', principal); ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  access = ctx.assistantDelivery.bindNativeWebOwner(ctx, { principal, workspace: root, preset: 'primary', maxExecutionMs: 30000 })
  const originalCreate=ctx.agents.create.bind(ctx.agents)
  if(options.holdDispose) {
    const gate=new Promise<void>(resolve=>{releaseDispose=resolve})
    vi.spyOn(ctx.agents,'create').mockImplementation(async input=>{
      const handle=await originalCreate(input)
      if(!String(handle.agent.session.id).startsWith('automation-')) return handle
      return {...handle,dispose:async()=>{await gate;await handle.dispose()}}
    })
  }
  const source = await access.create({ sessionId: 'ordinary-source' as SessionId, meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'local', model: 'scripted' } })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: true, tickIntervalMs: 1000, reconcileIntervalMs: 0 }).await()
  // Every delegated expiry must be bounded by the same owner authorization.
  // Separate clock reads could put a child expiry one millisecond past scope.
  const expiresAt = Date.now() + 3600000
  let workConfig: Config & { ownerRecall: { enabled: true } } = { enabled: true, mode: 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'), workerAutomationId: workerId,
    scope: { workspace: root, preset: 'primary', principalId, ownerRouteId: scope.authorityId, expiresAt }, ownerRecall: { enabled: true },
    admission: { allowedKinds: [options.genericParent ? 'review' : 'diagnosis','owner-continuation'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 }, limits: { maxReportBytes: 8192 },
    ownerContinuation: {enabled:true,automationId:'continuation-worker',allowedTools:continuationTools,budgetId:'continuation-runs',budgetAmount:1,maxModelCalls:24,maxToolCalls:22,maxOutputTokens:2048,timeoutMs:20000,expiresAt},
    ...(options.genericParent ? {} : {
      sources: { foregroundFailures: { enabled: true, kind: 'diagnosis', includeTimedOut: true, sweepIntervalMs: 60000, maxCandidatesPerSweep: 10, maxAdmitsPerSweep: 1 } },
      diagnosis: { enabled: true, budgetId: workerBudget, budgetAmount: 1, maxModelCalls: 5, maxToolCalls: 4, maxOutputTokens: 512, timeoutMs: 15000, expiresAt },
    }) }
  if (options.genericParent) {
    ctx.assistantAutomations.reconcileSystem({
      owner: workerOwner, automationId: workerId, idempotencyKey: 'ordinary-parent/v1', desiredStatus: 'active',
      definition: {
        name: 'Ordinary review worker', schedule: { kind: 'at', at: new Date(expiresAt).toISOString() }, prompt: 'Claim the review and report the result.',
        workspace: root, agentPreset: 'primary', principal: principalId, provider: 'local', model: 'scripted',
        allowedTools: ['work_item_claim', 'work_item_report'], maxToolCalls: 2, maxOutputTokens: 512, timeoutMs: 15000,
        misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, budgetId: workerBudget, budgetAmount: 1,
      },
    })
  }
  const marker=vi.fn(async()=>({written:true}));let lateAllows=0;const markerPreparedStates: unknown[]=[]
  if(options.markerAttack) {
    workConfig.ownerContinuation!.allowedTools=[...continuationTools,'continuation_marker']
    ctx.tools.register(defineTool({name:'continuation_marker',description:'Finite fixture marker, no external IO',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{written:{type:'boolean',required:true}}},render:()=>[]},execute:marker}))
  }
  if(options.acceptanceArtifact !== undefined) {
    supplier.writeAcceptanceArtifact=true
    workConfig.ownerContinuation!.allowedTools=[...continuationTools,'continuation_write_fixture']
    ctx.tools.register(defineTool({name:'continuation_write_fixture',description:'Write one fixed artifact for the independent fixture check',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{written:{type:'boolean',required:true}}},render:()=>[]},execute:async()=>{
      await writeFile(join(root,'verified-result.txt'),options.acceptanceArtifact!,{flag:'wx'})
      return {written:true}
    }}))
  }
  let workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()
  expect(ctx.tools.schemas().map(t => t.name)).toEqual(expect.arrayContaining(['work_item_list', 'work_item_recall', 'work_item_continue']))
  if(options.markerAttack) ctx.on('tools/pre-execute',async(execution,next)=>{if(execution.name==='continuation_marker'){lateAllows++;markerPreparedStates.push(query(join(root,'items.sqlite'),"SELECT report.status FROM work_item_report AS report JOIN work_item AS item ON report.item_id=item.id WHERE item.kind='owner-continuation'"));return {kind:'allow'}}return next()},{prepend:true})
  const authObservations: unknown[] = []
  ctx.on('tools/pre-execute', (execution, next) => {
    const agent = execution.agent
    if (agent && ['work_item_list', 'work_item_recall', 'work_item_continue'].includes(execution.name)) {
      const delivery = ctx.assistantDelivery
      authObservations.push({ deliveryGetIdentityStable: ctx.get('assistantDelivery') === ctx.get('assistantDelivery'), policyGetIdentityStable: ctx.get('assistantPolicy') === ctx.get('assistantPolicy'), signalAborted: execution.signal.aborted, name: execution.name, callIdType: typeof execution.callId, route: delivery.validateOwnerAgentForRoute(agent, scope.authorityId),
        turn: delivery.currentPreferenceTurn(agent), proof: delivery.inspectOwnerForegroundToolCall({ agent, authorityId: scope.authorityId, callId: String(execution.callId), toolName: execution.name, argumentsJson: JSON.stringify(execution.arguments) }),
        input:execution.name==='work_item_continue'?delivery.readOwnerForegroundToolInput({agent,authorityId:scope.authorityId,callId:String(execution.callId),toolName:execution.name,argumentsJson:JSON.stringify(execution.arguments),offset:0,maxBytes:8192}):undefined,health:ctx.assistantWorkItems.health(),policy: ctx.assistantPolicy.evaluateAgent(agent, execution.name==='work_item_continue'?'continue-work-items':'inspect-work-items', { kind: 'automation', id: execution.name==='work_item_continue'?'continuation-worker':workerId }) })
    }
    return next()
  }, { prepend: true })
  const snapshot = () => ({ workItems: ledger(join(root, 'items.sqlite')), runs: query(join(root, 'automations.sqlite'), 'SELECT * FROM automation_runs ORDER BY id'), budget: query(join(root, 'policy.sqlite'), 'SELECT * FROM budget_reservations ORDER BY id') })
  const produce = async () => {
    if (options.genericParent) {
      const binding = operator!.getActiveBinding(conversation)!
      const admitted = ctx.assistantWorkItems.admitDecision({
        protocol: 'work-items/execute-decision/v1', decisionId: 'ordinary-review', verdict: 'execute',
        origin: 'explicit', mode: 'auto', budgetRemaining: 1,
        mandate: {
          kind: 'review', title: 'Review the owner task', brief: 'Inspect the owner task 🧭.',
          originBindingId: binding.id, acceptanceRef: 'acceptance:ordinary-review/v1',
        },
      })
      expect(admitted).toMatchObject({ outcome: 'admitted', dispatch: { state: 'dispatched' } })
    } else {
      await access!.prompt({ sessionId: 'ordinary-source', requestId: 'source-failure', text: 'Inspect the owner task 🧭.', content: [{ type: 'text', text: 'Inspect the owner task 🧭.' }] }, async () => { source.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the owner task 🧭.' }], source: { kind: 'user', rpcId: 'source-failure' as never } })) }, new AbortController().signal)
    }
    await vi.waitFor(() => expect(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item')).toHaveLength(1), { timeout: 75000 })
    const itemId = String(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item')[0]!['id'])
    await vi.waitFor(() => expect(query(join(root, 'automations.sqlite'), 'SELECT status FROM automation_runs')).toHaveLength(1), { timeout: 20000 })
    await ctx.assistantAutomations.whenIdle()
    expect(query(join(root, 'items.sqlite'), 'SELECT state,attempt FROM work_item')).toEqual([expect.objectContaining({ state: 'ready', attempt: 1 })])
    return itemId
  }
  const newSession = async () => {
    const before = ctx.assistantDelivery.validateOwnerRoute(scope)
    await ctx.assistantDelivery.acceptInbound({ channel: 'web', account: 'browser', eventId: crypto.randomUUID(), occurredAt: Date.now(), principal, conversation, kind: 'command', text: '/new' })
    await ctx.assistantDelivery.tick(); await ctx.assistantDelivery.whenIdle()
    const binding = operator!.getActiveBinding(conversation)!
    expect(binding.sessionId).not.toBe('ordinary-source'); expect(binding.generation).toBeGreaterThan(before.generation)
    expect(ctx.assistantDelivery.validateOwnerRoute(scope).generation).toBe(binding.generation)
    return binding.sessionId
  }
  const ask = async (sessionId: string, commands: Command | Command[], text = 'Continue this owner task 🧭 with the new requirements.', provider = 'local', model = 'scripted') => {
    supplier.plans.set(sessionId,[...(Array.isArray(commands)?commands:[commands]),undefined])
    const handle = await access!.resume({ resumeSessionId: sessionId as SessionId, agentOptions: { provider, model } })
    const requestId = crypto.randomUUID(), content = [{ type: 'text' as const, text }]
    try {
      return await access!.prompt({ sessionId, requestId, text: content[0]!.text, content }, async () => {
        handle.agent.followup(createUserMessage({ content, source: { kind: 'user', rpcId: requestId as never } }))
        await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session)
        return handle.agent.session.snapshotEvents().filter(e => e.type === 'tool/result').at(-1)!.data.message
      }, new AbortController().signal)
    } finally { await handle.dispose() }
  }
  const restart=async()=>{await workFork.dispose();workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()}
  const enableAcceptance=async(objective:string,withProfile:boolean)=>{
    const owner=ctx.assistantDelivery.validateOwnerRoute(scope)
    const authority={kind:'runner' as const,id:'continuation-read-result',executable:process.execPath,
      fixedArgs:['-e',"process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))"],timeoutMs:5_000,maxOutputBytes:1024}
    const compiled=createVerifierAuthorities({authorities:[authority]})
    await ctx.plugin(AssistantVerifierService,{databasePath:join(root,'verifier.sqlite'),tickIntervalMs:0,authorities:[authority],profiles:withProfile?[{
      id:'continuation-result',version:1,scope:{workspace:root,preset:'primary'},owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},
      taskKind:'automation-run',objective,validityMs:60_000,bounds:{maxDurationMs:5_000,maxEvidenceBytes:4096},
      criteria:[{id:'result',kind:'process-behavior',authority:{id:authority.id,digest:compiled[0]!.digest},artifactPath:'verified-result.txt',stdin:'',expectedStdout:'verified',expectedExitCode:0}],
    }]:[]}).await()
    expect(options.genericParent).toBe(true)
    workConfig={...workConfig,acceptance:{bindWorkerRun:{enabled:true},autoSettle:{enabled:true},holdReport:{enabled:true,holdTimeoutMs:60_000}}}
    await restart()
  }
  const waitRuns=async(count:number)=>{await vi.waitFor(()=>expect(query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs')).toHaveLength(count),{timeout:30000});await ctx.assistantAutomations.whenIdle();return query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs ORDER BY created_at')}
  const waitParentReport=async()=>{await vi.waitFor(()=>expect(query(join(root,'items.sqlite'),'SELECT * FROM work_item_report')).toHaveLength(1),{timeout:75000});return String(query(join(root,'items.sqlite'),'SELECT id FROM work_item')[0]!.id)}
  return { markerPreparedStates,warnings,marker,lateAllows:()=>lateAllows,ctx,supplier,agents,operator,principal,scope,produce,newSession,ask,snapshot,root,authObservations,restart,enableAcceptance,waitRuns,waitParentReport,releaseSummary:()=>releaseSummary?.(),releaseDispose:()=>releaseDispose?.(),recallApprovalAsks:()=>recallApprovalAsks }
}

// Native Agent/Cordis/SQLite/Policy/Host are real. Only the LLM supplier is
// scripted, and the delivery transport is not connected to an external Bot.
function continuationRows(f: Awaited<ReturnType<typeof fixture>>) {
  return query(join(f.root,'items.sqlite'),'SELECT item_id,parent_item_id,root_item_id,source_key,CAST(input_text AS TEXT) AS input_text,CAST(plan_json AS TEXT) AS plan_json FROM work_item_continuation ORDER BY created_at')
}
function expectUnverifiedObjective(f: Awaited<ReturnType<typeof fixture>>, run: Record<string, unknown>, child: string) {
  const rows=query(join(f.root,'automations.sqlite'),"SELECT payload_json FROM automation_evaluation_outbox WHERE run_id='"+String(run.id)+"'")
  expect(rows).toHaveLength(1)
  expect(JSON.parse(String(rows[0]!.payload_json))).toMatchObject({executionStatus:'succeeded',objectiveStatus:'unknown'})
  const outcomes=query(join(f.root,'items.sqlite'),"SELECT objective_status FROM work_item_outcome WHERE item_id='"+child+"'")
  expect(outcomes.length).toBeGreaterThan(0)
  for(const outcome of outcomes) expect(outcome.objective_status).toBe('unknown')
}
function expectPages(f: Awaited<ReturnType<typeof fixture>>, child: string, parent: string, root: string, text: string, historicalReport = reportText) {
  const pages=[...f.supplier.pages.values()].find(pages=>pages[0]?.itemId===child)!
  expect(pages).toBeDefined()
  for(const page of pages) {
    expect(page).toMatchObject({itemId:child,parentItemId:parent,rootItemId:root})
    expect(page.returnedBytes).toBe(Buffer.byteLength(page.text));expect(page.returnedBytes).toBeLessThanOrEqual(512)
    expect(page.text).not.toContain('\uFFFD')
  }
  expect(pages.filter(p=>p.kind==='input').map(p=>p.text).join('')).toBe(text)
  const reports=pages.filter(p=>p.kind==='parent-report')
  expect(reports.map(p=>p.text).join('')).toBe(historicalReport)
  if(historicalReport===reportText) expect(reports.length).toBeGreaterThan(1)
  expect(pages.some(p=>p.kind==='parent-brief')).toBe(true)
}
describe('authenticated owner continuation through real native Host execution',()=>{
  test.each([['verified','achieved'],['wrong bytes','not-achieved']] as const)('verifies the exact continuation result (%s) before notifying the owner',async(artifact,verdict)=>{
    const f=await fixture({genericParent:true,acceptanceArtifact:artifact}),parent=await f.produce(),session=await f.newSession()
    const objective='  请续办：写入预期的结果🧭。\n'
    await f.enableAcceptance(objective,true)
    const verifierPath=join(f.root,'verifier.sqlite'),automationPath=join(f.root,'automations.sqlite')
    const contracts=()=>query(verifierPath,'SELECT id,payload FROM acceptance_contracts')
    f.supplier.beforeContinuationPrompt=()=>{
      expect(contracts().map(row=>JSON.parse(String(row.payload)))).toEqual([expect.objectContaining({objective})])
      expect(query(automationPath,'SELECT contract_id FROM automation_task_acceptance')).toEqual([{contract_id:contracts()[0]!.id}])
    }
    const result=await f.ask(session,{name:'work_item_continue',args:{item_id:parent}},objective)
    expect(result.isError,JSON.stringify(result.content)).toBe(false)
    const runs=await f.waitRuns(2)
    expect(runs[1],String(runs[1]?.diagnostic_json)).toMatchObject({automation_id:'continuation-worker',status:'succeeded',quiescent:1})
    expect(JSON.parse(String(contracts()[0]!.payload))).toMatchObject({objective,task:{kind:'automation-run',ref:`run-${String(runs[1]!.task_id)}`}})
    const reports=()=>query(join(f.root,'items.sqlite'),"SELECT report.* FROM work_item_report report JOIN work_item item ON item.id=report.item_id WHERE item.kind='owner-continuation'")
    expect(reports()).toEqual([expect.objectContaining({status:'ready',delivery_id:null})])
    const reportKey=String(reports()[0]!.delivery_key)
    const outbox=()=>query(join(f.root,'delivery.sqlite'),'SELECT id,idempotency_key FROM outbox_messages')
      .filter(row=>row.idempotency_key===reportKey || row.idempotency_key===`${reportKey}:blocked`)
    expect(outbox()).toEqual([])
    const worker=f.agents.find(agent=>String(agent.session.id)===String(runs[1]!.session_id))
    const events=worker?.session.snapshotEvents()??[]
    const writeCall=events.find(event=>event.type==='tool/call'&&event.data.name==='continuation_write_fixture')
    const writeResult=events.find(event=>event.type==='tool/result'&&writeCall?.type==='tool/call'
      &&String(event.data.message.source.callId)===String(writeCall.data.callId))
    const written=await readFile(join(f.root,'verified-result.txt'),'utf8').catch((error:unknown)=>String(error))
    const verifier=f.ctx.assistantVerifier
    expect(verifier).toBeInstanceOf(AssistantVerifierService)
    await verifier.tick()
    const receipt=verifier.inspectAcceptedTask(String(contracts()[0]!.id))?.receipt
    const detail=JSON.stringify({diagnostic:runs[1]!.diagnostic_json,writeResult,receipt,written,warnings:f.warnings})
    expect(writeResult,detail).toMatchObject({type:'tool/result',data:{message:{isError:false}}})
    expect(written,detail).toBe(artifact)
    expect(receipt,JSON.stringify(receipt)).toMatchObject({objectiveStatus:verdict})
    await vi.waitFor(async()=>{
      await f.ctx.assistantAutomations.tick()
      expect(reports()).toEqual([expect.objectContaining({delivery_id:expect.any(String)})])
    },{timeout:5_000})
    const outcomes=query(join(f.root,'items.sqlite'),"SELECT outcome.objective_status FROM work_item_outcome outcome JOIN work_item item ON item.id=outcome.item_id WHERE item.kind='owner-continuation'")
    // The worker's outcome remains self-reported. Only the independent
    // acceptance verdict can establish the checked objective status.
    expect(outcomes.length).toBeGreaterThan(0)
    for(const outcome of outcomes) expect(outcome.objective_status).toBe('unknown')
    expect(f.ctx.assistantWorkItems.acceptanceVerdict(String(reports()[0]!.item_id)))
      .toMatchObject({objectiveStatus:verdict,receiptId:receipt!.id,receiptDigest:receipt!.digest})
    await f.ctx.assistantAutomations.tick()
    expect(outbox()).toEqual([{
      id:reports()[0]!.delivery_id,
      idempotency_key:verdict==='not-achieved' ? `${reportKey}:blocked` : reportKey,
    }])
  },100000)

  test('a missing exact acceptance profile prevents the required continuation from reaching its first model prompt',async()=>{
    const f=await fixture({genericParent:true}),parent=await f.produce(),session=await f.newSession()
    const objective='请续办这条未经配置的目标。'
    await f.enableAcceptance(objective,false)
    const nativeRun=vi.spyOn(f.ctx.assistantAutomations,'runAgentForHostExecution')
    f.supplier.beforeContinuationPrompt=()=>{throw new Error('required continuation reached the model without an acceptance profile')}
    const result=await f.ask(session,{name:'work_item_continue',args:{item_id:parent}},objective)
    expect(result.isError,JSON.stringify(result.content)).toBe(false)
    const runs=await f.waitRuns(2)
    const diagnostic=String(runs[1]?.diagnostic_json)
    const workerSession=String(runs[1]!.session_id)
    expect(workerSession,diagnostic).toMatch(/^automation-/u)
    expect(f.agents.some(agent=>String(agent.session.id)===workerSession),diagnostic).toBe(true)
    expect(f.supplier.requests.filter(request=>String(request.sessionId)===workerSession),diagnostic).toHaveLength(0)
    expect(query(join(f.root,'verifier.sqlite'),'SELECT id FROM acceptance_contracts'),diagnostic).toHaveLength(0)
    expect(nativeRun,diagnostic).toHaveBeenCalledTimes(1)
    await expect(nativeRun.mock.results[0]!.value,diagnostic).rejects.toMatchObject({
      message:'required task acceptance profile is unavailable',
      diagnostic:{failureCode:'runtime-conflict',promptSubmissionState:'not-submitted'},
    })
    expect(query(join(f.root,'items.sqlite'),"SELECT attempt FROM work_item WHERE kind='owner-continuation'"),diagnostic)
      .toEqual([{attempt:0}])
    expect(query(join(f.root,'items.sqlite'),"SELECT report.item_id FROM work_item_report report JOIN work_item item ON item.id=report.item_id WHERE item.kind='owner-continuation'"),diagnostic)
      .toEqual([])
    expect(runs[1],diagnostic).toMatchObject({automation_id:'continuation-worker',status:'unknown'})
    expect(JSON.parse(diagnostic),diagnostic).toMatchObject({
      failureClass:'infrastructure',failurePhase:'host-execution',failureCode:'host-executor-failed',
      sideEffectState:'unknown',retryability:'unsafe',budgetSettlementState:'finalized',
    })
  },100000)

  test('uses the current owner input and paged historical report in one new production run and finite budget',async()=>{
    const f=await fixture(), parent=await f.produce(), session=await f.newSession()
    expect(f.snapshot().runs).toEqual([expect.objectContaining({status:'succeeded',execution_mode:'production',quiescent:1})])
    const text='请继续旧任务：保留先前结论，检查这条真实新要求🧭。'
    const result=await f.ask(session,{name:'work_item_continue',args:{item_id:parent}},text)
    expect(result.isError,JSON.stringify({content:result.content,auth:f.authObservations,warnings:f.warnings})).toBe(false)
    const runs=await f.waitRuns(2),links=continuationRows(f)
    expect(links).toHaveLength(1);const child=String(links[0]!.item_id)
    expect(links[0]).toMatchObject({parent_item_id:parent,root_item_id:parent,input_text:text})
    expect(runs).toEqual([expect.objectContaining({status:'succeeded',quiescent:1}),expect.objectContaining({status:'succeeded',execution_mode:'production',quiescent:1,automation_id:'continuation-worker'})])
    expectPages(f,child,parent,parent,text)
    expectUnverifiedObjective(f,runs[1]!,child)
    for(const agent of f.agents.filter(a=>String(a.session.id).startsWith('automation-'))) {
      const results=agent.session.snapshotEvents().filter(e=>e.type==='tool/result')
      expect(results.length).toBeGreaterThan(0)
      for(const result of results) expect(result.data.message.isError,JSON.stringify(result.data.message.content)).toBe(false)
    }
    expect(f.snapshot().budget).toHaveLength(2)
    for(const reservation of f.snapshot().budget) expect(reservation).toMatchObject({status:'finalized',amount:1,actual_amount:1})
    expect(query(join(f.root,'items.sqlite'),'SELECT item_id,status FROM work_item_report WHERE item_id='+"'"+child+"'")).toEqual([expect.objectContaining({item_id:child,status:'ready'})])
    const reports=query(join(f.root,'items.sqlite'),'SELECT delivery_id FROM work_item_report')
    const outbox=query(join(f.root,'delivery.sqlite'),'SELECT id FROM outbox_messages')
    for(const report of reports) expect(outbox).toContainEqual(expect.objectContaining({id:report.delivery_id}))
    expect(f.recallApprovalAsks()).toBe(0)
  },100000)

  test('deduplicates two actual continue calls within the same owner turn without a second child',async()=>{
    const f=await fixture(),parent=await f.produce(),session=await f.newSession()
    const command={name:'work_item_continue',args:{item_id:parent}}
    const result=await f.ask(session,[command,command])
    expect(result.isError,JSON.stringify({content:result.content,auth:f.authObservations,warnings:f.warnings})).toBe(false)
    await f.waitRuns(2)
    expect(continuationRows(f)).toHaveLength(1);expect(f.snapshot().budget).toHaveLength(2)
    const owner=f.agents.findLast(a=>String(a.session.id)===session)!
    expect(owner.session.snapshotEvents().filter(e=>e.type==='tool/call'&&e.data.name==='work_item_continue')).toHaveLength(2)
  },100000)

  test('cold WorkItems SQLite reopening and a new owner generation preserve ancestor refs but use the actual current supplier',async()=>{
    const f=await fixture(),parent=await f.produce(),session=await f.newSession()
    expect((await f.ask(session,{name:'work_item_continue',args:{item_id:parent}})).isError).toBe(false)
    await f.waitRuns(2);const child=String(continuationRows(f)[0]!.item_id)
    await f.restart();const nextSession=await f.newSession(),text='根据这次新消息继续第二轮🧭，供应商已明确更换。'
    const result=await f.ask(nextSession,{name:'work_item_continue',args:{item_id:child}},text,'replacement','current-model')
    expect(result.isError,JSON.stringify({content:result.content,auth:f.authObservations,warnings:f.warnings})).toBe(false)
    const runs=await f.waitRuns(3),links=continuationRows(f),last=links[1]!
    expect(links).toHaveLength(2);expect(last).toMatchObject({parent_item_id:child,root_item_id:parent,input_text:text})
    const plan=JSON.parse(String(last.plan_json))
    expect(plan.source.modelSelection).toMatchObject({provider:'replacement',model:'current-model'})
    const requests=f.supplier.requests.filter(r=>String(r.sessionId)===String(runs[2]!.session_id))
    expect(requests.length).toBeGreaterThan(1)
    for(const request of requests) expect(request).toMatchObject({provider:'replacement',model:'current-model'})
    expectPages(f,String(last.item_id),child,parent,text,'Continued from current owner input and bounded historical pages.')
    expect(f.snapshot().budget).toHaveLength(3)
    for(const reservation of f.snapshot().budget) expect(reservation).toMatchObject({status:'finalized',actual_amount:1})
  },100000)

  test('a ready report cannot authorize continuation while its real parent native run is still active',async()=>{
    const f=await fixture({holdSummary:true}),producing=f.produce()
    try {
      const parent=await f.waitParentReport(),session=await f.newSession()
      expect(f.snapshot().runs).toHaveLength(0)
      const result=await f.ask(session,{name:'work_item_continue',args:{item_id:parent}})
      expect(result.isError).toBe(true);expect(continuationRows(f)).toHaveLength(0)
      expect(f.snapshot().budget).toHaveLength(1)
    } finally {f.releaseSummary();await producing}
  },100000)

  test('unconfirmed parent teardown with a genuinely held disposer is not replayed as a continuation',async()=>{
    const f=await fixture({holdDispose:true})
    try {
      const parent=await f.produce(),session=await f.newSession()
      expect(f.snapshot().runs).toEqual([expect.objectContaining({status:'timed_out',quiescent:null})])
      expect(JSON.parse(String(f.snapshot().runs[0]!.diagnostic_json))).toMatchObject({sideEffectState:'unknown',budgetSettlementState:'unknown'})
      const result=await f.ask(session,{name:'work_item_continue',args:{item_id:parent}})
      expect(result.isError).toBe(true);expect(continuationRows(f)).toHaveLength(0)
      expect(f.snapshot().budget).toHaveLength(1)
    } finally {f.releaseDispose()}
  },100000)
  test('a late pre-execute allow cannot execute an allowed external marker after the terminal report',async()=>{
    const f=await fixture({markerAttack:true}),parent=await f.produce(),session=await f.newSession()
    expect((await f.ask(session,{name:'work_item_continue',args:{item_id:parent}})).isError).toBe(false)
    const runs=await f.waitRuns(2),child=String(continuationRows(f)[0]!.item_id)
    expect(query(join(f.root,'items.sqlite'),"SELECT status FROM work_item_report WHERE item_id='"+child+"'")).toEqual([{status:'ready'}])
    expect(f.lateAllows()).toBe(1);expect(f.marker).not.toHaveBeenCalled()
    const worker=f.agents.find(agent=>String(agent.session.id)===String(runs[1]!.session_id))!
    expect(worker.session.snapshotEvents().filter(e=>e.type==='tool/call'&&e.data.name==='continuation_marker')).toHaveLength(1)
    const rejected=worker.session.snapshotEvents().filter(e=>e.type==='tool/result').find(e=>e.data.message.isError)
    expect(rejected?.data.message.isError).toBe(true)
    expect(JSON.stringify(rejected?.data.message.content)).toMatch(/continuation tool authority or execution phase changed/u)
    expect(runs[1]).toMatchObject({status:'succeeded',quiescent:1})
    expectUnverifiedObjective(f,runs[1]!,child)
    // Execution ending normally does not assert that the denied marker ran.
    expect(f.snapshot().budget).toHaveLength(2)
  },100000)

  test('same-response report and marker obey the real native exclusive scheduling barrier',async()=>{
    const f=await fixture({markerAttack:true,groupedResponse:true}),parent=await f.produce(),session=await f.newSession()
    expect((await f.ask(session,{name:'work_item_continue',args:{item_id:parent}})).isError).toBe(false)
    const runs=await f.waitRuns(2)
    expect(f.lateAllows()).toBe(1);expect(f.marker).not.toHaveBeenCalled()
    expect(f.markerPreparedStates).toEqual([[{status:'ready'}]])
    expectUnverifiedObjective(f,runs[1]!,String(continuationRows(f)[0]!.item_id))
    const worker=f.agents.find(agent=>String(agent.session.id)===String(runs[1]!.session_id))!
    const requests=f.supplier.requests.filter(request=>String(request.sessionId)===String(worker.session.id))
    expect(requests.length).toBeGreaterThan(1)
    const events=worker.session.snapshotEvents(),calls=events.filter(e=>e.type==='tool/call')
    const report=calls.find(e=>e.data.name==='work_item_report')!,marker=calls.find(e=>e.data.name==='continuation_marker')!
    const reportResult=events.find(e=>e.type==='tool/result'&&String(e.data.message.source.callId)===String(report.data.callId))!
    const markerResult=events.find(e=>e.type==='tool/result'&&String(e.data.message.source.callId)===String(marker.data.callId))!
    expect(reportResult.type==='tool/result'&&reportResult.data.message.isError).toBe(false)
    expect(markerResult.type==='tool/result'&&markerResult.data.message.isError).toBe(true)
    if(markerResult.type==='tool/result') expect(JSON.stringify(markerResult.data.message.content)).toMatch(/continuation tool authority or execution phase changed/u)
    expect(marker.seq).toBeGreaterThan(report.seq)
    // Both calls came from one assistant response; the actual exclusive report
    // finished before marker preparation. No synthetic concurrent scheduler.
    const response=events.find(e=>e.type==='assistant/message'&&e.data.message.content.filter(block=>block.type==='tool-call').length===2)
    expect(response).toBeDefined()
  },100000)

})
