import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, resolveRetryPolicy, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type Config as DeliveryConfig } from '@dsh-enhanced/assistant-delivery'
import type { DeliveryAdapterContext, OutboundIntent, DeliveryToolApprovalRequest } from '../../assistant-delivery/lib/types.js'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, vi } from 'vitest'
import { AssistantWorkItemsService } from '../../assistant-work-items/lib/index.js'
import type { Config } from '../../assistant-work-items/lib/config.js'
import { AssistantVerifierService, compileCreationReviewConfig, type CreationReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PluginControlPlaneService, type Config as ControlPlaneConfig } from '@dsh-enhanced/plugin-control-plane'
import { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import GrowthPlugin, { type AssistantGrowthDriverConfig } from '../src/index.ts'
import type { LinuxRsiRepositoryBuildEnvironment } from '../../lark-channel/lib/rsi-linux-repository-bootstrap.js'
import type { LinuxRsiCreationBuildEnvironment } from '../../lark-channel/lib/rsi-linux-creation-build.js'
import type { prepareEngineeringMacRuntime } from './work-item-engineering.native.ts'

type MacEngineeringResources=Awaited<ReturnType<typeof prepareEngineeringMacRuntime>>['resources']
type EngineeringResources=MacEngineeringResources | (Omit<MacEngineeringResources,'sourceBuild'|'creationBuild'> & {
  sourceBuild:{backend:'linux-native';repository:LinuxRsiRepositoryBuildEnvironment;cgroupRoots:LinuxRsiCreationBuildEnvironment['cgroupRoots']};creationBuild:LinuxRsiCreationBuildEnvironment})
async function* engineeringTextChunks(value:unknown):AsyncIterable<StreamChunk> {
  const text=JSON.stringify(value);yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}}
  yield {type:'usage',usage:{inputTokens:10,outputTokens:40}};yield {type:'finish',reason:{kind:'stop'}}
}
/** Policy budget shared by the current Host usage-scan automation. */
export const engineeringScanBudgetId = 'engineering-scan'
export function engineeringCandidateFiles(name:string,broken:boolean,ignoreComments=false) {
  const split=broken?"const [key,value] = line.split('='); if(!key || value===undefined) throw new Error('invalid record');":"const at=line.indexOf('=');if(at<=0)throw new Error('invalid record');const key=line.slice(0,at),value=line.slice(at+1);"
  const content=`import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
export function normalizeRecords(text:string):Record<string,string>{
 const entries=new Map<string,string>();for(const line of text.split(/\\r?\\n/u)){if(!line.trim()${ignoreComments?"||line.startsWith('#')":''})continue;${split}if(entries.has(key))throw new Error('duplicate key');entries.set(key,value)}
 const compare=(a:string,b:string)=>{const x=Array.from(a,c=>c.codePointAt(0)!),y=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(x.length,y.length);i++){if(x[i]!==y[i])return x[i]!-y[i]!}return x.length-y.length};
 return Object.fromEntries([...entries.keys()].sort(compare).map(key=>[key,entries.get(key)!]))
}
export default {name:${JSON.stringify('dsh-enhanced-'+name)},inject:['tools'],apply(ctx:Context){ctx.tools.register(defineTool({name:'normalize_records',description:'Parse key=value records, preserving Unicode and all value characters.',parameters:{text:{type:'string',required:true}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args){return normalizeRecords(args.text)}}))}}
`
  return [{path:'src/index.ts',content},{path:'README.md',content:'# Pure record normalization\n\nParses text only, with no filesystem, subprocess, credential or network authority. Duplicate or empty keys are rejected.\n'},
    {path:'tests/index.spec.ts',content:"import { expect,test } from 'vitest'\nimport { normalizeRecords } from '../src/index.js'\ntest('ordinary records',()=>{expect(normalizeRecords('b=two\\na=one')).toEqual({a:'one',b:'two'})})\n"}]
}

const closes: Array<() => Promise<void>> = []
const supplierObservations: unknown[]=[]
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks();if(process.env['WORK_ITEM_ENGINEERING_NATIVE_EVIDENCE']) await writeFile(process.env['WORK_ITEM_ENGINEERING_NATIVE_EVIDENCE'],JSON.stringify(supplierObservations,null,2)+'\n') } })
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
  readonly querySessions=new Set<string>()
  readonly tag=randomUUID()
  readonly objective=`Create a pure tool normalize_records for task ${this.tag}. It accepts {text:string}, parses nonempty lines as key=value, splits only at the first =, rejects empty or duplicate keys, and returns a JSON object mapping each key to its unchanged value. Blank lines are ignored. No filesystem or network access. Preserve Unicode and values containing = exactly.`
  engineeringHandler: ((request:GenerateOptions)=>AsyncIterable<StreamChunk>) | undefined
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
    const foreground=this.plans.get(id)
    if(foreground){yield* chunks(foreground.shift());return}
    if(this.engineeringHandler && (request.tools?.length??0)===0) {yield* this.engineeringHandler(request);return}
    if(this.querySessions.has(id)){yield* chunks();return}
    if(this.engineeringHandler && request.tools?.some(tool=>tool.name.startsWith('plugin_source_'))) {yield* this.engineeringHandler(request);return}
    if(!id.startsWith('automation-')) throw new Error('offline foreground failure for actual diagnosis intake')
    const count=(this.counts.get(id)??0)+1;this.counts.set(id,count)
    if(!request.tools?.some(tool=>tool.name==='work_item_read_context')) {
      if(count===1) yield* chunks({name:'work_item_claim',args:{}})
      else if(count===2) yield* chunks({name:'work_item_read_source',args:{offset:0,max_bytes:512}})
      else if(count===3) yield* chunks({name:'work_item_report',args:{status:'ready',summary:reportText+' Task marker: '+this.tag}})
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
/** Debug-only evidence, after owned disposal and before temporary deletion.
 * Never visits the repository, runtime, keys or arbitrary directories. */
async function retainSourceBuildEvidence(root:string,tag:string):Promise<void> {
  const output=process.env['WORK_ITEM_ENGINEERING_NATIVE_EVIDENCE']
  if(!output)return
  const base=join(root,'source-build'),records:Array<{path:string;sha256:string;rawBase64:string}>=[]
  for(const relative of ['receipts','native-backend/receipts','native-backend/jobs']) {
    const directory=join(base,relative)
    if(!existsSync(directory))continue
    const info=await lstat(directory)
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw new Error('unsafe native evidence directory')
    for(const name of (await readdir(directory)).sort()) {
      if(!/^[a-f0-9-]+(?:\.partial)?\.json$/u.test(name))continue
      const file=join(directory,name),stat=await lstat(file)
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8388608||records.length>=32)throw new Error('native evidence record exceeds bounded regular files')
      const bytes=await readFile(file)
      records.push({path:relative+'/'+name,sha256:createHash('sha256').update(bytes).digest('hex'),rawBase64:bytes.toString('base64')})
    }
  }
  const database=join(base,'ledger.sqlite')
  await writeFile(output+'.'+tag+'.source-build.json',JSON.stringify({phase:'after-owned-disposal',ledger:existsSync(database)?ledger(database):[],records},null,2)+'\n',{mode:0o600})
}

/** Tuple comparison only; the caller must obtain the attestation from real
 * Delivery. A matching tuple cannot manufacture or authorize a tool call. */
export function matchesApprovalSource(task:Readonly<{inboxId:string;sessionId:string;binding:Readonly<{id:string}>}>|undefined,
  expected:Readonly<{inboxId:string;sessionId:string;bindingId:string}>|undefined):boolean {
  return !!task&&!!expected&&task.inboxId===expected.inboxId&&task.sessionId===expected.sessionId&&task.binding.id===expected.bindingId
}
export async function workItemEngineeringFixture(options: { replyEnabled?:boolean; holdSummary?: boolean; holdDispose?: boolean; markerAttack?: boolean; groupedResponse?: boolean; brokenCandidate?:boolean
  /** Opt-in: write sealed Docker-era history into the live journal before the Control Plane mounts. */
  sealedSeed?: (input:{root:string;statePath:string;capabilities:NonNullable<ControlPlaneConfig['creationCapabilities']>})=>Promise<void>
  /** Opt-in: route only Growth (author and creation verifier) to an explicitly mounted supplier. */
  realGrowthRoute?: {provider:string;model:string;maxOutputTokens:number} } = {}) {
  const queryResults:unknown[]=[]
  const sourceDiagnostics:unknown[]=[]
  const ownerApprovals:Array<{request:DeliveryToolApprovalRequest;matched:boolean;outcome:'allowed-once'|'rejected'}>=[]
  let expectedOwnerApproval:{alias:string;arguments:string;sessionId:string;bindingId:string;eventId:string;userText:string;used:boolean}|undefined
  const sent: Array<{providerMessageId:string;intent:Readonly<OutboundIntent>}> = []
  const root = await realpath(await mkdtemp(join(tmpdir(), 'work-item-engineering-native-')))
  const engineering: { authorJobId?:string; planId?:string; name?:string; candidateFrozenAt?:number; heldoutCreatedAt?:number; heldout?:unknown[]; certificate?:unknown; readiness?:unknown; candidateBaseCommit?:string; runtimeBaselineCommit?:string; artifactPath?:string; artifactSha256?:string; generatorDigest?:string; ackHostRuns?:unknown[]; sourceBinPins?:Array<{path:string;mode:string;blob:string}> }={}
  const workspace=join(root,'workspace');await mkdir(workspace,{mode:0o700})
  const ctx = new Context(), agents: Agent[] = [], supplier = new LocalSupplier(); supplier.markerAttack=options.markerAttack===true;supplier.groupedResponse=options.groupedResponse===true
  let releaseSummary: (() => void) | undefined
  if(options.holdSummary) supplier.summaryGate=new Promise<void>(resolve=>{releaseSummary=resolve})
  let operator: DeliveryStore | undefined
  closes.push(async () => { try {supplierObservations.push({test:expect.getState().currentTestName,requests:supplier.requests.map(request=>({sessionId:String(request.sessionId),provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort})),warnings,feedbackQueue:existsSync(join(root,'delivery.sqlite'))?query(join(root,'delivery.sqlite'),'SELECT * FROM delivery_work_item_feedback'):[],nativeSessions:agents.map(agent=>({sessionId:String(agent.session.id),events:agent.session.snapshotEvents()})),queryResults,sourceDiagnostics,ownerApprovals,supplierPayloads:supplier.payloads,pages:[...supplier.pages],adapterPayloads:sent,engineering,control:existsSync(join(root,'control-plane/control.sqlite'))?ledger(join(root,'control-plane/control.sqlite')):[],usage:existsSync(join(root,'engineering-usage.sqlite'))?ledger(join(root,'engineering-usage.sqlite')):[],adoptions:existsSync(join(root,'control-plane/creation-adoptions.sqlite'))?ledger(join(root,'control-plane/creation-adoptions.sqlite')):[],reviewLedger:existsSync(join(root,'verifier.sqlite.creation-reviews'))?ledger(join(root,'verifier.sqlite.creation-reviews')):[],evaluation:existsSync(join(root,'evaluation.sqlite'))?ledger(join(root,'evaluation.sqlite')):[],foreground:existsSync(join(root,'delivery.sqlite'))?query(join(root,'delivery.sqlite'),'SELECT * FROM delivery_foreground_executions'):[],continuations:existsSync(join(root,'items.sqlite'))?query(join(root,'items.sqlite'),'SELECT * FROM work_item_continuation'):[],network:'none: local scripted LlmAdapter only'});}finally{try { releaseSummary?.(); releaseDispose?.(); await ctx.fiber.dispose() } finally { try { await retainSourceBuildEvidence(root,supplier.tag) } finally { operator?.close(); await rm(root, { recursive: true, force: true }) } } }})
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
  const scope = { authorityId: 'recall-owner', principalId, workspace, agentPreset: 'primary' }
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0,
    budgets: ['diagnosis-runs','continuation-runs','engineering-author','engineering-scan','engineering-build'].map(id=>({id, metric: 'automation-runs', limit: 5, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' as const})), rules: [
      ...(['usage','source'] as const).flatMap(kind=>{const id=kind==='usage'?'assistant-growth-usage':'plugin-control-plane-source',pattern=kind==='usage'?'usage-*':'source-job-*';return [{id:kind+'-reconcile',effect:'allow' as const,subject:{kind:'background' as const,id,workspace,principal:principalId},actions:['reconcile'],resource:{kind:'automation' as const,id:pattern},context:{initiators:['background' as const]}},{id:kind+'-execute',effect:'allow' as const,subject:{kind:'background' as const,id:pattern,workspace,principal:principalId},actions:['execute'],resource:{kind:'automation' as const,id:pattern},context:{initiators:['background' as const]}}]}),
      {id:'growth-source-tools',effect:'allow',subject:{kind:'agent',id:'primary',workspace,principal:principalId},actions:['execute'],resource:{kind:'tool',id:'plugin_source_*'},context:{initiators:['background']}},
      {id:'adopted-owner-tools',effect:'allow',subject:{kind:'agent',id:'primary',workspace,principal:principalId},actions:['execute'],resource:{kind:'tool',id:'evolved_owner_*'},context:{initiators:['external']}},
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'paired-non-owner-ingest', effect:'allow',subject:{kind:'external',id:'web/browser/local/stranger'},actions:['pair.confirm','ingest'],resource:{kind:'message',id:'*'},context:{initiators:['external']} },
      { id: 'intake', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace }, actions: ['ingest'], resource: { kind: 'automation', id: 'diagnosis-worker' } },
      { id: 'install', effect: 'allow', subject: { kind: 'background', id: 'assistant-work-items-diagnosis', workspace, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'worker', effect: 'allow', subject: { kind: 'background', id: 'diagnosis-worker', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['background'] } },
      { id: 'tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'work_item_*' }, context: { initiators: ['external', 'background'] } },
      { id: 'marker', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'continuation_marker' }, context: { initiators: ['background'] } },
      { id: 'owner-reply', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'recall', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['inspect-work-items'], resource: { kind: 'automation', id: 'diagnosis-worker' }, context: { initiators: ['external'] } },
      ...(options.replyEnabled?[{ id: 'reply-continuation', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['continue-work-items-from-reply'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['external'] } } satisfies NonNullable<ConstructorParameters<typeof AssistantPolicyService>[1]['rules']>[number]]:[]),
      { id: 'feedback', effect:'allow', subject:{kind:'external',id:principalId},actions:['feedback-work-items'],resource:{kind:'automation',id:'continuation-worker'},context:{initiators:['external']} },
      { id: 'continue-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: principalId }, actions: ['continue-work-items'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['external'] } },
      { id: 'continue-admit', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'continue-event', effect: 'allow', subject: { kind: 'external', id: 'work-items/v1', workspace }, actions: ['ingest'], resource: { kind: 'automation', id: 'continuation-worker' } },
      { id: 'continue-install', effect: 'allow', subject: { kind: 'background', id: 'assistant-work-items-continuation', workspace, principal: principalId }, actions: ['reconcile'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'continue-worker', effect: 'allow', subject: { kind: 'background', id: 'continuation-worker', workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: 'continuation-worker' }, context: { initiators: ['background'] } },
      { id: 'send', effect: 'allow', subject: { kind: 'background', id: 'work-items/v1', workspace, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ] }).await()
  const Approval = await import(pathToFileURL(dep.resolve('@deepseek-ai/dsh-user-approval')).href)
  await ctx.plugin(Approval.default as never, { policy: 'ask' } as never).await()
  let recallApprovalAsks = 0
  ctx.on('approval/request', (request, next) => { if (['work_item_list', 'work_item_recall', 'work_item_continue'].includes(request.toolName)) recallApprovalAsks++; return next() }, { prepend: true })
  ctx.llm.registerAdapter(['local','replacement'], supplier)
  ctx.on('agent/created', ({ agent }) => { agents.push(agent) })
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const deliveryConfig: DeliveryConfig = { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    defaultWorkspace: workspace, defaultAgentPreset: 'primary', agentProvider: 'local', agentModel: 'scripted', agentMaxAutoContinuationTurns: 0,
    ownerRoutes: [{ id: scope.authorityId, conversation, principal, workspace, agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }] }
  const evaluationConfig={databasePath:join(root,'evaluation.sqlite'),projectionIntervalMs:0}
  let evaluationFork=ctx.plugin(AssistantEvaluationService,evaluationConfig);await evaluationFork.await()
  let deliveryFork=ctx.plugin(AssistantDeliveryService,deliveryConfig);await deliveryFork.await()
  operator = new DeliveryStore({ path: join(root, 'delivery.sqlite') })
  const pairing = ctx.assistantDelivery.issuePairing('test', principal); ctx.assistantDelivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  let adapterContext: DeliveryAdapterContext | undefined
  // Only the external approval-answer transport is replaced. Production
  // Delivery still derives and rechecks the exact current open-turn authority.
  const registerAdapter = async () => ctx.assistantDelivery.registerAdapter({channel:'web',account:'browser',capabilities:{reconcileUnknownSend:false,receipts:[],formats:['plain','markdown'],toolApprovals:true},start:async context=>{adapterContext=context},send:async intent=>{const providerMessageId=`local-provider-${sent.length+1}`;sent.push({providerMessageId,intent});return {outcome:'accepted',providerMessageId}},requestToolApproval:async(request,signal)=>{
    const expected=expectedOwnerApproval,binding=operator!.getActiveBinding(conversation)
    const agent=agents.findLast(candidate=>String(candidate.session.id)===expected?.sessionId)
    const inbox=expected?operator!.getInboxByProviderEvent('web','browser',expected.eventId):undefined
    const proof=agent&&expected?ctx.assistantDelivery.inspectOwnerForegroundToolCall({agent,authorityId:scope.authorityId,callId:request.callId,toolName:request.toolName,argumentsJson:request.arguments}):undefined
    const matched=!!expected&&!expected.used&&!signal.aborted&&Date.now()<request.expiresAt
      &&matchesApprovalSource(proof?.task,expected&&inbox?{inboxId:inbox.id,sessionId:expected.sessionId,bindingId:expected.bindingId}:undefined)
      &&binding?.id===expected.bindingId&&binding.sessionId===expected.sessionId&&request.bindingId===expected.bindingId
      &&request.toolName===expected.alias&&request.arguments===expected.arguments
      &&isDeepStrictEqual(request.target.principal,principal)&&isDeepStrictEqual(request.target.conversation,conversation)
      &&inbox?.envelope.kind==='text'&&inbox.envelope.text===expected.userText
    const outcome=matched?'allowed-once' as const:'rejected' as const
    if(matched)expected!.used=true
    ownerApprovals.push({request:JSON.parse(JSON.stringify(request)),matched,outcome});return outcome
  }})
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
    scope: { workspace, preset: 'primary', principalId, ownerRouteId: scope.authorityId, expiresAt }, ownerRecall: { enabled: true }, ownerReplyContinuation: options.replyEnabled===true, ownerReportFeedback:true,
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
  await ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'source-failure',occurredAt:Date.now(),principal,conversation,kind:'text',text:supplier.objective})
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
    expect(typeof ctx.assistantWorkItems.issueOwnerWorkItemFeedbackTarget).toBe('function')
    expect(typeof ctx.assistantEvaluation.getTrustedWorkItemLearningProjection).toBe('function')
    expect(typeof ctx.assistantDelivery.inspectOwnerWorkItemLearningTask).toBe('function')
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
  const reopen=async()=>{await workFork.dispose();await deliveryFork.dispose();await evaluationFork.dispose();evaluationFork=ctx.plugin(AssistantEvaluationService,evaluationConfig);await evaluationFork.await();deliveryFork=ctx.plugin(AssistantDeliveryService,deliveryConfig);await deliveryFork.await();await registerAdapter();workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()}
  const restart=async()=>{await workFork.dispose();workFork=ctx.plugin(AssistantWorkItemsService,workConfig);await workFork.await()}
  const waitRuns=async(count:number)=>{await vi.waitFor(()=>expect(query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs')).toHaveLength(count),{timeout:30000});await ctx.assistantAutomations.whenIdle();return query(join(root,'automations.sqlite'),'SELECT * FROM automation_runs ORDER BY created_at')}
  const waitParentReport=async()=>{await vi.waitFor(()=>expect(query(join(root,'items.sqlite'),'SELECT * FROM work_item_report')).toHaveLength(1),{timeout:75000});return String(query(join(root,'items.sqlite'),'SELECT id FROM work_item')[0]!.id)}
  let verifierFork:Awaited<ReturnType<typeof ctx.plugin>>|undefined
  let controlFork:Awaited<ReturnType<typeof ctx.plugin>>|undefined
  let growthFork:Awaited<ReturnType<typeof ctx.plugin>>|undefined
  let controlConfig: ControlPlaneConfig|undefined
  let growthConfig: AssistantGrowthDriverConfig|undefined
  const resourcesPath=process.env['DSH_WORK_ITEM_ENGINEERING_RESOURCES']
  let reviewConfig:CreationReviewConfig|undefined
  const mountEngineering=async()=>{
    if(!resourcesPath)throw new Error('real prepared engineering runtime resource path required')
    const resource=JSON.parse(await readFile(resourcesPath,'utf8')) as EngineeringResources
    if(resource.protocol!=='work-item-engineering-native-fixture/v1'||resource.source.sourceCommit!==resource.baselineCommit)throw new Error('invalid native resource source identity')
    if(resource.sourceBuild.backend==='macos-seatbelt'&&process.platform!=='darwin'||resource.sourceBuild.backend==='linux-native'&&process.platform!=='linux')throw new Error('native backend does not match this host')
    const repository=join(root,'candidate-repository')
    const git=(...args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'file'},stdio:['ignore','pipe','pipe']}).trim()
    if(resource.sourceBuild.backend==='macos-seatbelt') {
      git('clone','--quiet','--local','--no-hardlinks','--no-checkout',resource.repository,repository)
      git('-C',repository,'checkout','--quiet','--detach',resource.baselineCommit)
      if(git('-C',repository,'rev-parse','HEAD')!==resource.baselineCommit)throw new Error('candidate generator baseline differs')
    } else {
      // A real, separately committed fixture repository keeps the exact pinned
      // lock, workspace and public generator/template. Its trusted check script
      // checks the newly generated plugin, never claims this monorepo passed.
      await mkdir(repository,{mode:0o700})
      const fixed=new Set(['scripts/create-plugin.mjs','LICENSE','plugins/README.md','package.json','pnpm-workspace.yaml','pnpm-lock.yaml','tsconfig.base.json','.npmrc'])
      const files=git('-C',resource.repository,'ls-tree','-r','--name-only',resource.baselineCommit).split('\n').filter(path=>fixed.has(path)||path.startsWith('templates/plugin/')||/^(plugins|packages)\/[^/]+\/package\.json$/u.test(path))
      for(const path of files){await mkdir(dirname(join(repository,path)),{recursive:true,mode:0o700});const bytes=execFileSync('/usr/bin/git',['-C',resource.repository,'show',resource.baselineCommit+':'+path],{maxBuffer:8388608});await writeFile(join(repository,path),bytes,{mode:0o600})}
      // Preserve each immutable manifest's non-generated executable input.
      // pnpm may normalize bins; the production archive guard requires these
      // real baseline files and their Git owner-executable mode up front.
      const binPins=new Map<string,{path:string;mode:string;blob:string}>()
      for(const manifestPath of files.filter(path=>path==='package.json'||path.endsWith('/package.json'))) {
        const manifest=JSON.parse(await readFile(join(repository,manifestPath),'utf8')) as {bin?:string|Record<string,string>}
        const values=typeof manifest.bin==='string'?[manifest.bin]:Object.values(manifest.bin??{})
        for(const declared of values) {
          const relative=declared.replace(/^\.\//u,'')
          if(relative.startsWith('lib/'))continue
          if(relative.split('/').some(part=>!part||part==='.'||part==='..')||relative.includes('\\'))throw new Error('baseline package bin path is unsafe')
          const path=manifestPath==='package.json'?relative:dirname(manifestPath)+'/'+relative
          if(binPins.has(path))continue
          const entry=git('-C',resource.repository,'ls-tree',resource.baselineCommit,'--',path)
          const match=/^(100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry)
          if(!match||match[3]!==path)throw new Error('baseline package bin is not an executable Git blob: '+path)
          const bytes=execFileSync('/usr/bin/git',['-C',resource.repository,'show',resource.baselineCommit+':'+path],{maxBuffer:8388608})
          const target=join(repository,path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o755,flag:'wx'})
          const stat=await lstat(target)
          if(!stat.isFile()||stat.isSymbolicLink()||!(stat.mode&0o100)||!(await readFile(target)).equals(bytes))throw new Error('fixture package bin differs from baseline: '+path)
          binPins.set(path,{path,mode:match[1]!,blob:match[2]!})
        }
      }
      engineering.sourceBinPins=[...binPins.values()]
      const packagePath=join(repository,'package.json'),manifest=JSON.parse(await readFile(packagePath,'utf8'))
      manifest.scripts={...manifest.scripts,check:'node scripts/engineering-fixture-check.mjs'}
      await writeFile(packagePath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600})
      const check=`import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const root=process.env.PLUGIN_ROOT
if(!root||!/^plugins\\/[a-z][a-z0-9-]+$/u.test(root))throw new Error('invalid frozen candidate plugin root')
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'))
if(!manifest.name.startsWith('@dsh-enhanced/owner-engineering-'))throw new Error('candidate outside fixture namespace')
for(const args of [['--dir',root,'run','typecheck'],['--dir',root,'exec','vitest','run','--maxWorkers=1'],['--dir',root,'run','build']]){
 const result=spawnSync('pnpm',args,{stdio:'inherit',env:{...process.env,CI:'1',ROLLDOWN_WORKER_THREADS:'1'}})
 if(result.error)throw result.error
 if(result.status!==0)process.exit(result.status??1)
}
`
      await writeFile(join(repository,'scripts/engineering-fixture-check.mjs'),check,{mode:0o600})
      git('-C',repository,'init','--quiet','--initial-branch=dev')
      git('-C',repository,'add','--all')
      git('-C',repository,'-c','user.name=Engineering Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','frozen real generator and bounded native plugin checks')
      for(const pin of engineering.sourceBinPins) {
        if(git('-C',repository,'ls-tree','HEAD','--',pin.path)!==`${pin.mode} blob ${pin.blob}\t${pin.path}`)throw new Error('committed fixture package bin mode/content changed: '+pin.path)
      }
      const expected=execFileSync('/usr/bin/git',['-C',resource.repository,'show',resource.baselineCommit+':pnpm-lock.yaml'],{maxBuffer:8388608})
      if(!expected.equals(await readFile(join(repository,'pnpm-lock.yaml'))))throw new Error('fixture must retain the production runtime exact base lock')
    }
    const candidateBaseCommit=git('-C',repository,'rev-parse','HEAD')
    if(resource.sourceBuild.backend==='linux-native') {
      // Exercise the actual public-generator contract before any author wake.
      // This only reads a template in an isolated temporary workspace; it does
      // not enqueue a source job, consume a grant, build or claim success.
      const baselineManifest=JSON.parse(execFileSync('/usr/bin/git',['-C',resource.repository,'show',resource.baselineCommit+':package.json'],{maxBuffer:8388608}).toString('utf8'))
      if(JSON.parse(await readFile(join(repository,'package.json'),'utf8')).scripts?.['create:plugin']!==baselineManifest.scripts?.['create:plugin'])throw new Error('fixture must preserve the exact baseline public generator command')
      const {inspectSourceCreationContext}=await import('../../plugin-control-plane/lib/source-creation.js')
      const probe=await inspectSourceCreationContext({repository,name:'owner-engineering-preflight',paths:['src/index.ts'],baseCommit:candidateBaseCommit,
        environment:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},signal:AbortSignal.timeout(15000),assertCurrent:()=>{},
        grant:{id:'read-only-fixture-probe',expiresAt:Date.now()+30000,maxCreates:1,namePrefix:'owner-engineering-'}})
      engineering.generatorDigest=probe.generatorDigest
    }
    engineering.candidateBaseCommit=candidateBaseCommit;engineering.runtimeBaselineCommit=resource.baselineCommit
    const currentOwner=ctx.assistantDelivery.validateOwnerRoute(scope)
    const {authorityId,authorityHash,principalRecordId,principalVersion,agentPreset}=currentOwner
    const owner={authorityId,authorityHash,principalId,principalRecordId,principalVersion,workspace,agentPreset}
    const until=Date.now()+1800000,namePrefix='owner-engineering-'
    const key=async(name:string)=>{const pair=generateKeyPairSync('ed25519'),path=join(root,name+'.pem');await writeFile(path,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});await chmod(path,0o600);return {path,publicKey:pair.publicKey.export({format:'pem',type:'spki'}).toString()}}
    const reviewer=await key('independent-review'),adopter=await key('bounded-adoption')
    const runner=async(name:string)=>{
      const stateRoot=join(root,name);await mkdir(stateRoot,{mode:0o700})
      return resource.creationBuild.backend==='macos-seatbelt'
        ? {backend:'macos-seatbelt' as const,runtime:resource.creationBuild.runtime,stateRoot,expiresAt:until,maxRuns:12,maxTotalDurationMs:240000,maxDurationMs:30000,maxOutputBytes:65536}
        : {backend:'linux-native' as const,runtime:resource.creationBuild.behavior,cgroupRoots:resource.creationBuild.cgroupRoots,stateRoot,expiresAt:until,maxRuns:12,maxTotalDurationMs:240000,maxDurationMs:30000,maxOutputBytes:65536}
    }
    reviewConfig={authorityId:'engineering-review',owner,namePrefix,keyId:'engineering-review-key',keyPath:reviewer.path,expiresAt:until,maxVerifications:1,
      runner:await runner('private-review-runner'),policy:'Check the exact authenticated pure key=value parsing task. Worker reports are background. Generate independent positive held-out cases that preserve Unicode and values containing equals signs. Reject candidates that cannot perform the specified transformation.',
      maxInputBytes:262144,maxOutputTokens:2048,maxDurationMs:180000,maxCases:3,receiptTtlMs:300000,workItemFailures:true}
    const compiled=compileCreationReviewConfig(reviewConfig)
    await ctx.plugin(AssistantGoalsService,{databasePath:join(root,'goals.sqlite')}).await()
    await ctx.plugin(AssistantSkillsService,{databasePath:join(root,'skills.sqlite')}).await()
    verifierFork=ctx.plugin(AssistantVerifierService,{databasePath:join(root,'verifier.sqlite'),tickIntervalMs:0,creationReviews:reviewConfig});await verifierFork.await()
    const catalogPath=join(root,'catalog.json'),trustPath=join(root,'trust.json'),executor=await realpath(process.execPath)
    await writeFile(catalogPath,JSON.stringify({schemaVersion:1,entries:[]}),{mode:0o600})
    const {defaultHostAttestationPolicy,loadTrustConfig}=await import('../../plugin-control-plane/lib/trust.js')
    const registry=join(root,'unused-private-release-registry');await mkdir(registry,{mode:0o700})
    // The real trust loader requires independent nonempty public key sets,
    // even though this fixture grants no source/release signing operation.
    const unusedTrustKey=(authority:string)=>({authority,keyId:authority,publicKeyPem:generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString()})
    await writeFile(trustPath,JSON.stringify({schemaVersion:4,installationId:randomUUID(),dshHome:root,ledger:{id:randomUUID(),path:join(root,'control-plane','control.sqlite')},
      executor:{id:'engineering-fixture-node',version:process.version,path:executor,sha256:createHash('sha256').update(await readFile(executor)).digest('hex'),environmentAllowlist:[]},
      hostPolicy:defaultHostAttestationPolicy,hostAttestor:null,releaseRegistry:{id:'unused-fixture-registry',locator:pathToFileURL(registry).href,protocol:'dsh',tokenEnvironment:null},releaseAdapters:Object.fromEntries(['pr','review','merge','build','sign','publish','registry-verify','catalog-admission'].map(phase=>[phase,null])),catalog:{id:'engineering-catalog',path:catalogPath},releaseReceiptTtlMs:30000,approvalKeys:[unusedTrustKey('unused-source-approval')],hostAttestationKeys:[unusedTrustKey('unused-host-attestation')],releaseKeys:[unusedTrustKey('unused-adapter-receipt')],releaseAuthorizationKeys:[unusedTrustKey('unused-release-authorization')]}),{mode:0o600})
    await mkdir(join(root,'control-plane'),{mode:0o700})
    await loadTrustConfig(trustPath) // Validate the complete production trust contract before dispatch.
    const stateRoot=join(root,'source-build');await mkdir(stateRoot,{mode:0o700})
    const authorityDigest=createHash('sha256').update(JSON.stringify({owner,runtime:resource.sourceBuild,expiresAt:until})).digest('hex')
    const common={stateRoot,authorityDigest,expiresAt:until,maxRuns:2,maxTotalDurationMs:180000,timeoutMs:60000,outputBytes:1048576,versioning:'patch' as const}
    const sourceBuild:NonNullable<ControlPlaneConfig['sourceBuild']>=resource.sourceBuild.backend==='macos-seatbelt'
      ? {...resource.sourceBuild,...common}
      : {...common,timeoutMs:180000,maxTotalDurationMs:360000,backend:'linux-native',runtime:resource.sourceBuild.repository.runtime,systemSnapshot:resource.sourceBuild.repository.systemSnapshot,userNamespace:resource.sourceBuild.repository.userNamespace,cgroupRoots:resource.sourceBuild.cgroupRoots,
        memoryMiB:2048,cpus:1,pidsLimit:128,workspaceMiB:1024,temporaryMiB:256,workspaceInodes:100000,temporaryInodes:16384}
    controlConfig={catalogPath,trustPath,statePath:join(root,'control-plane'),sourceBuild,
      sourceJobs:{authorityId:'engineering-source-jobs',expiresAt:until,maxSubmissions:1,allowedModes:['create'],repository,
        creation:{id:'engineering-create',workItemFailures:true,expiresAt:until,maxCreates:1,namePrefix},ownerRouteId:authorityId,principalId,workspace,preset:agentPreset,budgetId:'engineering-build',budgetAmount:1},
      creationVerifications:{authority:compiled.authority,publicKey:compiled.publicKey},
      creationCapabilities:{workItemFailures:true,authorityId:'engineering-adoption',keyId:'engineering-adoption-key',keyPath:adopter.path,owner,namePrefix,expiresAt:until,maxAdoptions:options.sealedSeed?2:1,maxTools:1,maxCallsPerAdoption:3,maxCallRecords:3,maxInputBytes:16384,runner:await runner('adoption-runner')}}
    if(options.sealedSeed)await options.sealedSeed({root,statePath:controlConfig.statePath,capabilities:controlConfig.creationCapabilities!})
    controlFork=ctx.plugin(PluginControlPlaneService,controlConfig);await controlFork.await()
    const diagnostic=()=>{const internal=ctx.pluginControlPlane as unknown as {sourceRuntime?:{inspectWorkItemReadiness:(owner:typeof currentOwner)=>unknown};creationCapabilityRuntime?:{inspectWorkItemAdoptionReadiness:()=>unknown}};return {source:internal.sourceRuntime?.inspectWorkItemReadiness(currentOwner),review:ctx.assistantVerifier.inspectWorkItemCreationReviewReadiness(),adoption:internal.creationCapabilityRuntime?.inspectWorkItemAdoptionReadiness(),preparedProtocol:ctx.pluginControlPlane.inspectWorkItemPreparedCreationProtocol(),health:ctx.pluginControlPlane.health(),fiberState:controlFork?.state}}
    let readiness=ctx.pluginControlPlane.inspectWorkItemCreationReadiness({owner:currentOwner})
    await vi.waitFor(()=>{readiness=ctx.pluginControlPlane.inspectWorkItemCreationReadiness({owner:currentOwner});expect(readiness?.available,JSON.stringify({readiness,diagnostic:diagnostic(),warnings})).toBe(true)},{timeout:15000})
    if(!readiness?.available)throw new Error('real source/review/adoption lane is not ready')
    engineering.readiness=readiness
    growthConfig={enabled:true,intervalMs:0,scope:{workspace,preset:agentPreset,principalId,ownerRouteId:authorityId},budgetId:'engineering-author',budgetAmount:1,
      ...(options.realGrowthRoute?{provider:options.realGrowthRoute.provider,model:options.realGrowthRoute.model}:{}),
      maxModelCalls:5,maxToolCalls:4,maxOutputTokens:options.realGrowthRoute?.maxOutputTokens??8192,maxDurationMs:120000,maxReviewsPerWake:1,
      usageLearning:{enabled:true,databasePath:join(root,'engineering-usage.sqlite'),scanBudgetId:engineeringScanBudgetId,scanBudgetAmount:1,workItemFailures:true,workItemAuthorities:readiness.pins},
      pluginSourceProposals:{enabled:true,preparationMode:'durable',allowCreation:true,allowModification:false,allowRevision:false,repository,maxPlansPerWake:1,offline:true,planTtlMs:900000}}
    let authorStage=0,gapId:string|undefined,pluginName:string|undefined,ignoreComments=false
    const lastJson=(request:GenerateOptions)=>{const message=request.messages.filter(m=>m.role==='tool').at(-1);if(!message)throw new Error('actual source tool result missing');return JSON.parse(message.content.filter(c=>c.type==='text').map(c=>c.text).join(''))}
    supplier.engineeringHandler=async function*(request){
      const session=String(request.sessionId)
      if(request.tools?.some(t=>t.name==='plugin_source_gaps')) {
        if(authorStage===0){ignoreComments=JSON.stringify({system:request.system,messages:request.messages}).includes('ignore lines whose first character is #');authorStage++;yield* chunks({name:'plugin_source_gaps',args:{}});return}
        if(authorStage===1){const gaps=lastJson(request) as Array<{id:string}>;if(gaps.length!==1)throw new Error('author must discover exactly its actual owner gap');gapId=gaps[0]!.id
          const description=request.tools.find(t=>t.name==='plugin_source_read')?.description??'',prefix=/begin with ([a-z][a-z0-9-]*-)/u.exec(description)?.[1]
          if(!prefix)throw new Error('actual creation namespace missing');pluginName=prefix+'records-'+supplier.tag.slice(0,8);engineering.name=pluginName;authorStage++
          yield* chunks({name:'plugin_source_read',args:{gap_id:gapId,plugin_name:pluginName,mode:'create',paths:['README.md','src/index.ts','tests/index.spec.ts']}});return}
        if(authorStage===2){const template=lastJson(request) as {name:string;contents:Array<{path:string;content:string}>};if(template.name!==pluginName||template.contents.length!==3)throw new Error('actual fixed template not read')
          authorStage++;yield* chunks({name:'plugin_source_create',args:{gap_id:gapId,plugin_name:pluginName,files:engineeringCandidateFiles(pluginName!,options.brokenCandidate===true,ignoreComments)}});return}
        if(authorStage===3){const job=lastJson(request) as {id:string;mode:string};if(job.mode!=='create'||!job.id)throw new Error('actual source job receipt missing');engineering.authorJobId=job.id;authorStage++;yield* chunks();return}
        throw new Error('extra paid author step beyond frozen plan')
      }
      if(session.startsWith('creation-contract-')) {
        if(engineering.heldout)throw new Error('contract session cannot choose a second oracle')
        if(!engineering.authorJobId)throw new Error('held-out cases created before author job receipt')
        const job=ctx.pluginControlPlane.inspectSourceJob({id:engineering.authorJobId,owner:{ownerRouteId:scope.authorityId,principalId,principalRecordId,principalVersion,workspace,preset:agentPreset}})
        if(!job.planId)throw new Error('held-out cases require a frozen prepared candidate')
        engineering.planId=job.planId
        const prepared=ctx.pluginControlPlane.inspectPreparedCreation(job.planId)
        if(!prepared.artifact.length||prepared.plan.preparedEvidence?.pack.sha256!==createHash('sha256').update(prepared.artifact).digest('hex'))throw new Error('real prepared artifact bytes missing')
        engineering.candidateFrozenAt=Date.now()
        // The independent oracle reads its own authenticated Host input, never
        // the author's interpretation or candidate output.
        const reviewMessage=request.messages.filter(message=>message.role==='user').at(-1)
        if(!reviewMessage)throw new Error('independent reviewer task input missing')
        const reviewData=JSON.parse(reviewMessage.content.filter(block=>block.type==='text').map(block=>block.text).join('')) as {task:{objective:string}}
        if(prepared.protocol!=='dsh-prepared-creation/v2'||reviewData.task.objective!==prepared.source.objective)throw new Error('independent reviewer objective differs from authenticated prepared source')
        const reviewObjective=JSON.parse(reviewData.task.objective) as {protocol:string;inputs:Array<{text:string}>}
        if(reviewObjective.protocol!=='work-item-owner-objective/v1'||!reviewObjective.inputs.length||reviewObjective.inputs.some(input=>typeof input.text!=='string'))throw new Error('independent reviewer objective framing missing')
        const reviewIgnoresComments=reviewObjective.inputs.some(input=>input.text.includes('ignore lines whose first character is #'))
        const nonce=randomUUID(),ordinaryText=`z=${nonce}\na=first`,challengeText=`β=值=${nonce}\na=🧭`,extraText=(reviewIgnoresComments?`#ignored=${nonce}\n`:'')+`\nq==${nonce}\n\np=last\n`
        engineering.heldout=[{id:'independent-ordinary',toolName:'normalize_records',arguments:{text:ordinaryText},purpose:'ordinary',expected:{kind:'json-value',value:{a:'first',z:nonce}},rationale:'Independent random values and out-of-order keys.'},
          {id:'independent-equals-unicode',toolName:'normalize_records',arguments:{text:challengeText},purpose:'challenge',expected:{kind:'json-value',value:{a:'🧭','β':'值='+nonce}},rationale:'The value includes another equals and multibyte Unicode.'},
          {id:'independent-leading-equals',toolName:'normalize_records',arguments:{text:extraText},purpose:'challenge',expected:{kind:'json-value',value:{p:'last',q:'='+nonce}},rationale:'Blank lines and a leading equals inside the unchanged value.'}]
        engineering.heldoutCreatedAt=Date.now();yield* engineeringTextChunks({status:'cases',cases:engineering.heldout});return
      }
      if(session.startsWith('creation-source-')) {yield* engineeringTextChunks({decision:'approved',reason:'Scripted independent source review of pure parsing implementation; actual frozen held-out cases were executed by the native observer.'});return}
      throw new Error('unexpected offline engineering supplier session '+session)
    }
    growthFork=ctx.plugin(GrowthPlugin,growthConfig);await growthFork.await()
  }
  const saveNativeEvidence=async(planId:string):Promise<ReturnType<PluginControlPlaneService['inspectPreparedCreation']>>=>{
    const prepared=ctx.pluginControlPlane.inspectPreparedCreation(planId),certificate=ctx.pluginControlPlane.inspectVerifiedCreation(planId)
    engineering.planId=planId;engineering.certificate=certificate
    engineering.artifactSha256=createHash('sha256').update(prepared.artifact).digest('hex')
    const evidence=process.env['WORK_ITEM_ENGINEERING_NATIVE_EVIDENCE']
    if(evidence){
      const path=evidence+'.'+supplier.tag+'.artifact.tgz'
      await writeFile(path,prepared.artifact,{mode:0o600});engineering.artifactPath=path
      await writeFile(path+'.json',JSON.stringify({plan:prepared.plan,job:prepared.job,reference:prepared.reference,source:prepared.source,certificate},null,2)+'\n',{mode:0o600})
    }
    return prepared
  }
  const remountEngineering=async()=>{
    if(!controlConfig||!growthConfig||!reviewConfig)throw new Error('engineering grants not initialized')
    await growthFork?.dispose();await controlFork?.dispose();await verifierFork?.dispose()
    verifierFork=ctx.plugin(AssistantVerifierService,{databasePath:join(root,'verifier.sqlite'),tickIntervalMs:0,creationReviews:reviewConfig});await verifierFork.await()
    controlFork=ctx.plugin(PluginControlPlaneService,controlConfig);await controlFork.await()
    growthFork=ctx.plugin(GrowthPlugin,growthConfig);await growthFork.await()
  }
  const invokeOwner=async(alias:string,text:string)=>{
    await ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:randomUUID(),occurredAt:Date.now(),principal,conversation,kind:'command',text:'/new'})
    await ctx.assistantDelivery.tick();await ctx.assistantDelivery.whenIdle()
    const binding=operator!.getActiveBinding(conversation)!
    supplier.plans.set(binding.sessionId,[{name:alias,args:{text}},undefined])
    const approvalStart=ownerApprovals.length,eventId=randomUUID(),userText=`Use the adopted normalization tool for task ${supplier.tag} on this exact input:\n${text}`
    expectedOwnerApproval={alias,arguments:JSON.stringify({text}),sessionId:binding.sessionId,bindingId:binding.id,eventId,userText,used:false}
    await ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId,occurredAt:Date.now(),principal,conversation,kind:'text',text:userText})
    await ctx.assistantDelivery.tick();await ctx.assistantDelivery.whenIdle()
    const agent=agents.findLast(agent=>String(agent.session.id)===binding.sessionId)
    if(!agent)throw new Error('actual new owner Agent missing')
    const events=agent.session.snapshotEvents(),call=events.find(e=>e.type==='tool/call'&&e.data.name===alias)
    if(!call||call.type!=='tool/call')throw new Error('actual new owner did not invoke alias')
    const result=events.find(e=>e.type==='tool/result'&&String(e.data.message.source.callId)===String(call.data.callId))
    if(!result||result.type!=='tool/result')throw new Error('actual alias result missing')
    expectedOwnerApproval=undefined
    return {sessionId:binding.sessionId,events,result:result.data.message,approvals:ownerApprovals.slice(approvalStart)}
  }

  return { ownerApprovals,sourceDiagnostics,saveNativeEvidence,engineering,mountEngineering,remountEngineering,invokeOwner,stopEngineering:async()=>growthFork?.dispose(),controlConfig:()=>controlConfig,workspace, evaluationConfig, stopWorkItems, deliveryConfig, reopen, reply,acceptReports,sent,workConfig,registerAdapter,conversation, markerPreparedStates,warnings,marker,lateAllows:()=>lateAllows,ctx,supplier,agents,operator,principal,scope,produce,snapshot,root,authObservations,restart,waitRuns,waitParentReport,releaseSummary:()=>releaseSummary?.(),releaseDispose:()=>releaseDispose?.(),recallApprovalAsks:()=>recallApprovalAsks }
}

// Native Agent/Cordis/SQLite/Policy/Host are real. Only the LLM supplier is
// scripted, and the delivery transport is not connected to an external Bot.