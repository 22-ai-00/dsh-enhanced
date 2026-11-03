import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, resolveRetryPolicy, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type Config as DeliveryConfig } from '@dsh-enhanced/assistant-delivery'
import type { DeliveryAdapterContext, OutboundIntent } from '../../assistant-delivery/lib/types.js'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, vi } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { Config } from '../src/config.ts'

const closes: Array<() => Promise<void>> = []
const supplierObservations: unknown[]=[]
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks();if(process.env['NATIVE_OWNER_REPLY_EVIDENCE']) await writeFile(process.env['NATIVE_OWNER_REPLY_EVIDENCE'],JSON.stringify(supplierObservations,null,2)+'\n') } })
export const reportText = '旧报告🧭：跨会话保留中文与边界🙂。'.repeat(40)
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
  readonly payloads: unknown[] = []
  readonly plans = new Map<string, Array<Command | undefined>>()
  readonly counts = new Map<string, number>()
  readonly pages = new Map<string, ContextPage[]>()
  readonly stages = new Map<string, { kind: number; offset: number; last?: Command | undefined; reported?: boolean; attacked?: boolean }>()
  groupedResponse = false
  markerAttack = false
  summaryGate: Promise<void> | undefined
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'owner continuation offline fixture') }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text'] as const } }
  override async *stream(request: GenerateOptions) {
    try { yield* this.script(request) } catch(error) { capture(error); throw error }
  }
  private async *script(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);this.payloads.push(JSON.parse(JSON.stringify({sessionId:String(request.sessionId),provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort,system:request.system,messages:request.messages,tools:request.tools}))); if(this.requests.length>512) throw new Error('finite scripted supplier cap')
    const id=String(request.sessionId)
    if(!id.startsWith('automation-')) throw new Error('offline foreground failure for actual diagnosis intake')
    const foreground=this.plans.get(id)
    if(foreground) { yield* chunks(foreground.shift()); return }
    const count=(this.counts.get(id)??0)+1;this.counts.set(id,count)
    if(!request.tools?.some(tool=>tool.name==='work_item_read_context')) {
      if(count===1) yield* chunks({name:'work_item_claim',args:{}})
      else if(count===2) yield* chunks({name:'work_item_read_source',args:{offset:0,max_bytes:512}})
      else if(count===3) yield* chunks({name:'work_item_report',args:{status:'ready',summary:reportText}})
      else { await this.summaryGate; yield* chunks() }
      return
    }
    const stage=this.stages.get(id)??{kind:0,offset:0};this.stages.set(id,stage)
    if(count===1) {yield* chunks({name:'work_item_claim',args:{}});return}
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
    else if(!stage.reported) {command={name:'work_item_report',args:{status:'ready',summary:'Continued from current owner input and bounded historical pages.'}};stage.reported=true}
    if(stage.reported && !command && this.markerAttack && !stage.attacked) {command={name:'continuation_marker',args:{}};stage.attacked=true}
    stage.last=command
    if(command?.name==='work_item_report'&&this.groupedResponse) {stage.attacked=true;yield* chunks([command,{name:'continuation_marker',args:{}}]);return}
    yield* chunks(command)
  }
}
export function query(path: string, sql: string) {
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
export async function replyFixture(options: { holdSummary?: boolean; holdDispose?: boolean; markerAttack?: boolean; groupedResponse?: boolean } = {}) {
  const sent: Array<{providerMessageId:string;intent:Readonly<OutboundIntent>}> = []
  const root = await mkdtemp(join(tmpdir(), 'owner-continuation-native-'))
  const ctx = new Context(), agents: Agent[] = [], supplier = new LocalSupplier(); supplier.markerAttack=options.markerAttack===true;supplier.groupedResponse=options.groupedResponse===true
  let releaseSummary: (() => void) | undefined
  if(options.holdSummary) supplier.summaryGate=new Promise<void>(resolve=>{releaseSummary=resolve})
  let operator: DeliveryStore | undefined
  closes.push(async () => { supplierObservations.push({test:expect.getState().currentTestName,requests:supplier.requests.map(request=>({sessionId:String(request.sessionId),provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort})),supplierPayloads:supplier.payloads,pages:[...supplier.pages],adapterPayloads:sent,foreground:query(join(root,'delivery.sqlite'),'SELECT * FROM delivery_foreground_executions'),continuations:query(join(root,'items.sqlite'),'SELECT * FROM work_item_continuation'),network:'none: local scripted LlmAdapter only'});try { releaseSummary?.(); releaseDispose?.(); await ctx.fiber.dispose() } finally { operator?.close(); await rm(root, { recursive: true, force: true }) } })
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
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0,
    budgets: ['diagnosis-runs','continuation-runs'].map(id=>({id, metric: 'automation-runs', limit: 5, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' as const})), rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'intake', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace: root, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'install', effect: 'allow', subject: { kind: 'background', id: 'assistant-work-items-diagnosis', workspace: root, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'worker', effect: 'allow', subject: { kind: 'background', id: 'diagnosis-worker', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'work_item_*' }, context: { initiators: ['external', 'background'] } },
      { id: 'marker', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'continuation_marker' }, context: { initiators: ['background'] } },
      { id: 'owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'recall', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root, principal: principalId }, actions: ['inspect-work-items'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['external'] } },
      { id: 'reply-continuation', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['continue-work-items-from-reply'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['external'] } },
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
  ctx.on('approval/request', (request, next) => { if (['work_item_list', 'work_item_recall', 'work_item_continue'].includes(request.toolName)) recallApprovalAsks++; return next() }, { prepend: true })
  ctx.llm.registerAdapter(['local','replacement'], supplier)
  ctx.on('agent/created', ({ agent }) => { agents.push(agent) })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const deliveryConfig: DeliveryConfig = { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    defaultWorkspace: root, defaultAgentPreset: 'primary', agentProvider: 'local', agentModel: 'scripted', agentMaxAutoContinuationTurns: 0,
    ownerRoutes: [{ id: scope.authorityId, conversation, principal, workspace: root, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }] }
  let deliveryFork=ctx.plugin(AssistantDeliveryService,deliveryConfig);await deliveryFork.await()
  operator = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
  const pairing = ctx.assistantDelivery.issuePairing('test', principal); ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  let adapterContext: DeliveryAdapterContext | undefined
  const registerAdapter = async () => ctx.assistantDelivery.registerAdapter({channel:'web',account:'browser',capabilities:{reconcileUnknownSend:false,receipts:[],formats:['plain','markdown']},start:async context=>{adapterContext=context},send:async intent=>{const providerMessageId=`local-provider-${sent.length+1}`;sent.push({providerMessageId,intent});return {outcome:'accepted',providerMessageId}}})
  await registerAdapter()
  const originalCreate=ctx.agents.create.bind(ctx.agents)
  if(options.holdDispose) {
    const gate=new Promise<void>(resolve=>{releaseDispose=resolve})
    vi.spyOn(ctx.agents,'create').mockImplementation(async input=>{
      const handle=await originalCreate(input)
      if(!String(handle.agent.session.id).startsWith('automation-')) return handle
      return {...handle,dispose:async()=>{await gate;await handle.dispose()}}
    })
  }
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: true, tickIntervalMs: 1000, reconcileIntervalMs: 0 }).await()
  // Every delegated expiry must be bounded by the same owner authorization.
  // Separate clock reads could put a child expiry one millisecond past scope.
  const expiresAt = Date.now() + 3600000
  const workConfig: Config & { ownerRecall: { enabled: true } } = { enabled: true, mode: 'active', databasePath: join(root, 'items.sqlite'), workRoot: join(root, 'work'), workerAutomationId: 'diagnosis-worker',
    scope: { workspace: root, preset: 'primary', principalId, ownerRouteId: scope.authorityId, expiresAt }, ownerRecall: { enabled: true }, ownerReplyContinuation: true,
    admission: { allowedKinds: ['diagnosis','owner-continuation'], maxOpenItems: 10, maxAdmitsPerHour: 10, cooldownMs: 0 }, limits: { maxReportBytes: 8192 },
    sources: { foregroundFailures: { enabled: true, kind: 'diagnosis', includeTimedOut: true, sweepIntervalMs: 60000, maxCandidatesPerSweep: 10, maxAdmitsPerSweep: 1 } },
    ownerContinuation: {enabled:true,automationId:'continuation-worker',allowedTools:continuationTools,budgetId:'continuation-runs',budgetAmount:1,maxModelCalls:24,maxToolCalls:22,maxOutputTokens:2048,timeoutMs:20000,expiresAt},
    diagnosis: { enabled: true, budgetId: 'diagnosis-runs', budgetAmount: 1, maxModelCalls: 5, maxToolCalls: 4, maxOutputTokens: 512, timeoutMs: 15000, expiresAt } }
  const marker=vi.fn(async()=>({written:true}));let lateAllows=0;const markerPreparedStates: unknown[]=[]
  if(options.markerAttack) {
    workConfig.ownerContinuation!.allowedTools=[...continuationTools,'continuation_marker']
    ctx.tools.register(defineTool({name:'continuation_marker',description:'Finite fixture marker, no external IO',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{written:{type:'boolean',required:true}}},render:()=>[]},execute:marker}))
  }
  // Real authenticated admission establishes the owner route before worker activation.
  await ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'source-failure',occurredAt:Date.now(),principal,conversation,kind:'text',text:'Inspect the owner task 🧭.'})
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
        input:execution.name==='work_item_continue'?delivery.readOwnerForegroundToolInput({agent,authorityId:scope.authorityId,callId:String(execution.callId),toolName:execution.name,argumentsJson:JSON.stringify(execution.arguments),offset:0,maxBytes:8192}):undefined,health:ctx.assistantWorkItems.health(),policy: ctx.assistantPolicy.evaluateAgent(agent, execution.name==='work_item_continue'?'continue-work-items':'inspect-work-items', { kind: 'automation', id: execution.name==='work_item_continue'?'continuation-worker':'diagnosis-worker' }) })
    }
    return next()
  }, { prepend: true })
  const snapshot = () => ({ workItems: ledger(join(root, 'items.sqlite')), runs: query(join(root, 'automations.sqlite'), 'SELECT * FROM automation_runs ORDER BY id'), budget: query(join(root, 'policy.sqlite'), 'SELECT * FROM budget_reservations ORDER BY id') })
  const produce = async () => {
    expect(typeof ctx.assistantDelivery.workItemReplyProtocolVersion).toBe('function')
    expect(ctx.assistantDelivery.workItemReplyProtocolVersion()).toBe(1)
    await ctx.assistantDelivery.tick();await ctx.assistantDelivery.whenIdle()
    expect(query(join(root,'delivery.sqlite'),'SELECT status,quiescent FROM delivery_foreground_executions'),JSON.stringify({warnings,requests:supplier.requests.map(r=>({sessionId:r.sessionId,provider:r.provider})),inbox:query(join(root,'delivery.sqlite'),'SELECT status,failure_code FROM inbox_messages')})).toEqual([expect.objectContaining({status:expect.stringMatching(/^(failed|unknown)$/u)})])
    await vi.waitFor(() => expect(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item'),JSON.stringify(warnings)).toHaveLength(1), { timeout: 15000 })
    const itemId = String(query(join(root, 'items.sqlite'), 'SELECT id FROM work_item')[0]!['id'])
    const source=operator!.getInboxByProviderEvent('web','browser','source-failure')!
    expect(query(join(root,'delivery.sqlite'),"SELECT inbox_id,status,termination_json FROM delivery_foreground_executions")).toEqual([expect.objectContaining({inbox_id:source.id,status:'unknown',termination_json:expect.any(String)})])
    expect(supplier.requests.filter(request=>!String(request.sessionId).startsWith('automation-'))).toHaveLength(1)
    await vi.waitFor(() => expect(query(join(root, 'automations.sqlite'), 'SELECT status FROM automation_runs')).toHaveLength(1), { timeout: 20000 })
    await ctx.assistantAutomations.whenIdle()
    expect(query(join(root, 'items.sqlite'), 'SELECT state,attempt FROM work_item')).toEqual([expect.objectContaining({ state: 'ready', attempt: 1 })])
    return itemId
  }
  const replyTimes=new Map<string,number>()
  const reply=async(providerMessageId:string,text:string,eventId:string=crypto.randomUUID())=>{const occurredAt=replyTimes.get(eventId)??Date.now();replyTimes.set(eventId,occurredAt);return adapterContext!.accept({channel:'web',account:'browser',eventId,occurredAt,principal,conversation,kind:'text',text,metadata:{replyToProviderMessageId:providerMessageId}})}
  const acceptReports=async()=>{await ctx.assistantDelivery.tick();await ctx.assistantDelivery.whenIdle();return sent}
  const stopWorkItems=async()=>workFork.dispose()
  const reopen=async()=>{await workFork.dispose();await deliveryFork.dispose();deliveryFork=ctx.plugin(AssistantDeliveryService,deliveryConfig);await deliveryFork.await();await registerAdapter();workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()}
  const restart=async()=>{await workFork.dispose();workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()}
  const waitRuns=async(count:number)=>{await vi.waitFor(()=>expect(query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs')).toHaveLength(count),{timeout:30000});await ctx.assistantAutomations.whenIdle();return query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs ORDER BY created_at')}
  const waitParentReport=async()=>{await vi.waitFor(()=>expect(query(join(root,'items.sqlite'),'SELECT * FROM work_item_report')).toHaveLength(1),{timeout:75000});return String(query(join(root,'items.sqlite'),'SELECT id FROM work_item')[0]!.id)}
  return { stopWorkItems, deliveryConfig, reopen, reply,acceptReports,sent,workConfig,registerAdapter,conversation, markerPreparedStates,warnings,marker,lateAllows:()=>lateAllows,ctx,supplier,agents,operator,principal,scope,produce,snapshot,root,authObservations,restart,waitRuns,waitParentReport,releaseSummary:()=>releaseSummary?.(),releaseDispose:()=>releaseDispose?.(),recallApprovalAsks:()=>recallApprovalAsks }
}

// Native Agent/Cordis/SQLite/Policy/Host are real. Only the LLM supplier is
// scripted, and the delivery transport is not connected to an external Bot.
export function continuationRows(f: Awaited<ReturnType<typeof replyFixture>>) {
  return query(join(f.root,'items.sqlite'),'SELECT item_id,parent_item_id,root_item_id,source_key,CAST(input_text AS TEXT) AS input_text,CAST(plan_json AS TEXT) AS plan_json FROM work_item_continuation ORDER BY created_at')
}
export function expectUnverifiedObjective(f: Awaited<ReturnType<typeof replyFixture>>, run: Record<string, unknown>, child: string) {
  const rows=query(join(f.root,'automations.sqlite'),"SELECT payload_json FROM automation_evaluation_outbox WHERE run_id='"+String(run.id)+"'")
  expect(rows).toHaveLength(1)
  expect(JSON.parse(String(rows[0]!.payload_json))).toMatchObject({executionStatus:'succeeded',objectiveStatus:'unknown'})
  const outcomes=query(join(f.root,'items.sqlite'),"SELECT objective_status FROM work_item_outcome WHERE item_id='"+child+"'")
  expect(outcomes.length).toBeGreaterThan(0)
  for(const outcome of outcomes) expect(outcome.objective_status).toBe('unknown')
}
export function expectPages(f: Awaited<ReturnType<typeof replyFixture>>, child: string, parent: string, root: string, text: string, historicalReport = reportText) {
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
