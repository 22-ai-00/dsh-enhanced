import {Context,Service} from '@deepseek-ai/cordis'
import {AssistantPolicyService} from '@dsh-enhanced/assistant-policy'
import {AssistantEvaluationService} from '@dsh-enhanced/assistant-evaluation'
import type {TrustedWorkItemEvaluationRegistration,TrustedWorkItemOwnerFeedbackProof} from '@dsh-enhanced/assistant-evaluation'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {acceptanceCanonicalJson} from '@dsh-enhanced/task-acceptance-contract'
import {frameWorkItemEngineeringContext,validateWorkItemEngineeringMaterial,type WorkItemEngineeringMaterial,type EngineeringNode,type EngineeringRootInput,type OwnerWorkItemEngineeringContextLocator} from '../src/work-item-engineering-context.js'
import type {InboundAttachmentDescriptor} from '../src/types.js'
import {afterEach,describe,expect,test,vi} from 'vitest'
import {AssistantDeliveryService} from '../src/service.js'
import {DeliveryStore} from '../src/store.js'
import {workItemReplyDigest,type WorkItemReportTarget,type WorkItemReplyConsumerRegistration} from '../src/work-item-replies.js'
const roots:string[]=[],contexts:Context[]=[]
const principal={channel:'lark',account:'feedback',tenant:'tenant',user:'owner'}
const conversation={channel:'lark',account:'feedback',tenant:'tenant',kind:'dm' as const,chat:'owner-chat'}
const scope={workspace:'/work/feedback',preset:'primary'},sourceId='work-item-intake',automationId='continuation'
const authority={id:'owner-route',conversation,principal,workspace:scope.workspace,agentPreset:scope.preset,policyRef:'owner',minimumGeneration:1}
const sql=<T>(path:string,fn:(db:DatabaseSync)=>T):T=>{const db=new DatabaseSync(path);try{return fn(db)}finally{db.close()}}
afterEach(async()=>{for(const ctx of contexts.splice(0))await ctx.fiber.dispose();for(const path of roots.splice(0))await rm(path,{recursive:true,force:true})})
async function fixture(options:{root?:string;feedback?:boolean;continuation?:boolean;allowFeedback?:boolean;allowSend?:boolean;unknownAck?:boolean}={}){
 const root=options.root??await mkdtemp(join(tmpdir(),'delivery-work-item-feedback-'));if(!options.root)roots.push(root)
 const ctx=new Context();contexts.push(ctx);const path=join(root,'delivery.sqlite')
 await ctx.plugin(AssistantPolicyService,{databasePath:join(root,'policy.sqlite'),rules:[
  {id:'ingest',effect:'allow',subject:{kind:'external',id:'lark/feedback/tenant/owner'},actions:['ingest'],resource:{kind:'message',id:'*'},context:{initiators:['external']}},
  {id:'send',effect:'allow',subject:{kind:'background',id:sourceId,workspace:scope.workspace,principal:'lark/feedback/tenant/owner'},actions:['send'],resource:{kind:'message',id:'*'},context:{initiators:['background']}},
  ...(options.allowFeedback===false?[]:[{id:'feedback',effect:'allow' as const,subject:{kind:'external' as const,id:'lark/feedback/tenant/owner',workspace:scope.workspace,principal:'lark/feedback/tenant/owner'},actions:['feedback-work-items'],resource:{kind:'automation' as const,id:automationId},context:{initiators:['external' as const]}}]),
  ...(options.continuation?[{id:'continue',effect:'allow' as const,subject:{kind:'external' as const,id:'lark/feedback/tenant/owner'},actions:['continue-work-items-from-reply'],resource:{kind:'automation' as const,id:automationId},context:{initiators:['external' as const]}}]:[]),
 ]})
 await ctx.plugin(AssistantDeliveryService,{databasePath:path,spoolPath:join(root,'spool'),schedulerEnabled:false,ownerRoutes:[authority]})
 const service=ctx.assistantDelivery,store=(service as unknown as {deliveryStore:DeliveryStore}).deliveryStore
 if(!store.getPrincipal(principal)){const pair=store.issuePairing(principal,{ttlMs:60000,maxAttempts:3});store.confirmPairing({challengeId:pair.challenge.id,principal,code:pair.code})}
 const binding=store.getActiveBinding(conversation)??store.createBinding({conversation,principal,workspace:scope.workspace,agentPreset:scope.preset,sessionId:'session-1',policyRef:'owner'})
 const ownerRow=store.getPrincipal(principal)!,owner={principalRecordId:ownerRow.id,principalVersion:ownerRow.version}
 const reports=new Map<string,{target:WorkItemReportTarget;bindingId:string;text:string;key:string;createdAt:number}>()
 sql(path,db=>{for(const row of db.prepare('SELECT outbox_id,target_json FROM delivery_work_item_reports').all() as {outbox_id:string;target_json:string}[]){const target=JSON.parse(row.target_json) as WorkItemReportTarget,outbox=store.getOutbox(row.outbox_id)!;reports.set(target.itemId,{target,bindingId:outbox.intent.bindingId,text:outbox.intent.text,key:outbox.intent.idempotencyKey,createdAt:outbox.createdAt})}})
 let ready=true,current=true,resolverHook:(()=>void)|undefined,ownsHook:(()=>void)|undefined,batchHook:((itemId:string)=>void)|undefined
 const capabilities=new WeakMap<object,TrustedWorkItemOwnerFeedbackProof>()
 let material:Readonly<WorkItemEngineeringMaterial>|undefined,engineeringHook:(()=>void)|undefined
 const engineeringCaps=new WeakMap<object,Readonly<WorkItemEngineeringMaterial>>()
 const registration:WorkItemReplyConsumerRegistration={protocol:1,sourceId,continuationAutomationId:automationId,feedbackEnabled:options.feedback!==false,continuationEnabled:options.continuation??false,
  inspectReport:vi.fn(input=>{const r=reports.get(input.itemId);return r&&r.bindingId===input.bindingId&&r.key===input.idempotencyKey&&r.text===input.text&&r.target.reportRevision===input.reportRevision?r.target:undefined}),
  inspectChild:()=>true,onPending:vi.fn(),onCancelled:vi.fn()}
 const peer={ownsWorkItemReplyRegistration:(input:unknown)=>{ownsHook?.();return current&&input===registration},
  trustedWorkItemProducerGeneration:()=> 'feedback-test-generation',registerTrustedWorkItemEvaluationSink:(_r:TrustedWorkItemEvaluationRegistration)=>()=>{},
  issueOwnerWorkItemFeedbackTarget:(input:{itemId:string;reportRevision:number;reportDigest:string})=>{
   const r=reports.get(input.itemId);if(!ready||!current||!r||r.target.reportRevision!==input.reportRevision||r.target.reportDigest!==input.reportDigest)return undefined
   const unsigned={protocol:'assistant-work-items/owner-report-feedback/v1' as const,itemId:r.target.itemId,reportRevision:r.target.reportRevision,reportDigest:r.target.reportDigest,sourceId,itemKind:'owner-continuation',scope,
    owner:{ownerRouteId:authority.id,principalId:'lark/feedback/tenant/owner',...owner},originBindingId:r.bindingId,
    production:{automationId,occurrenceId:`occ-${input.itemId}`,runId:`run-${input.itemId}`,definitionHash:'a'.repeat(64),definitionVersion:1,executionStatus:'failed' as const,completedAt:r.createdAt,quiescent:true as const,budgetSettlementState:'finalized' as const},
    supplier:{provider:'scripted',model:'frozen-model'},planDigest:'b'.repeat(64),task:{brief:'Original task brief token=secret-value',briefTruncated:false},report:{status:'blocked' as const,text:r.text,truncated:false,recordedAt:r.createdAt}}
   const capability={};capabilities.set(capability,{...unsigned,proofDigest:workItemReplyDigest(unsigned)});return capability
  },resolveOwnerWorkItemFeedbackTarget:(capability:unknown)=>{resolverHook?.();return ready&&current&&capability&&typeof capability==='object'?capabilities.get(capability):undefined},
  issueOwnerWorkItemEngineeringTarget:(feedback:unknown)=>{if(!ready||!current||!feedback||typeof feedback!=='object'||!capabilities.has(feedback)||!material)return undefined;const cap={};const proof=capabilities.get(feedback)!;const value=sealMaterial({...material,feedbackProofDigest:proof.proofDigest});engineeringCaps.set(cap,value);return cap},
  resolveOwnerWorkItemEngineeringTarget:(cap:unknown)=>ready&&current&&cap&&typeof cap==='object'?engineeringCaps.get(cap):undefined,
  withOwnerWorkItemEngineeringTargetsFence:<T>(caps:readonly unknown[],callback:(materials:readonly (Readonly<WorkItemEngineeringMaterial>|undefined)[])=>T):T=>{
   engineeringHook?.();return callback(caps.map(cap=>ready&&current&&cap&&typeof cap==='object'?engineeringCaps.get(cap):undefined))
  },
  withOwnerWorkItemFeedbackTargetsFence:<T>(caps:readonly unknown[],callback:(proofs:readonly (Readonly<TrustedWorkItemOwnerFeedbackProof>|undefined)[])=>T):T=>{
   const proofs=caps.map(cap=>{const proof=cap&&typeof cap==='object'?capabilities.get(cap):undefined;if(proof)batchHook?.(proof.itemId);resolverHook?.();return proof})
   return callback(proofs.map(proof=>ready&&current&&proof&&reports.get(proof.itemId)?.target.reportDigest===proof.reportDigest?proof:undefined))
  }}
 class WorkItemsPeerService extends Service { constructor(context:Context){super(context,'assistantWorkItems' as never);Object.assign(this,peer)} }
 await ctx.plugin(WorkItemsPeerService)
 service.registerWorkItemReplyConsumer(registration)
 await ctx.plugin(AssistantEvaluationService,{databasePath:join(root,'evaluation.sqlite'),projectionIntervalMs:0})
 const evaluation=ctx.assistantEvaluation
 service.registerInboundRuntime({createSession:async input=>({sessionId:`session-${input.generation}`,workspace:scope.workspace,agentPreset:scope.preset,policyRef:'owner'}),process:vi.fn(async()=>({outcome:'processed' as const}))})
 let sendSequence=sql(path,db=>Number(db.prepare("SELECT count(*) AS n FROM outbox_messages WHERE provider_message_id IS NOT NULL").get()?.n))
 const send=vi.fn(async(intent:{idempotencyKey:string})=>options.unknownAck&&intent.idempotencyKey.startsWith('feedback:')?{outcome:'unknown' as const,failureCode:'unknown'}:{outcome:'accepted' as const,providerMessageId:`provider-${++sendSequence}`})
 await service.registerAdapter({channel:'lark',account:'feedback',capabilities:{formats:['plain','markdown'],receipts:[],reconcileUnknownSend:false},start:async()=>{},send})
 async function report(itemId='P',streamId=itemId){const target:WorkItemReportTarget={protocol:'assistant-delivery/work-item-report/v1',itemId,reportRevision:1,streamId,reportDigest:workItemReplyDigest(['report',itemId]),sourceId,scope,owner};const text=`Report for ${itemId}`,key=`report:${itemId}`;reports.set(itemId,{target,bindingId:binding.id,text,key,createdAt:Date.now()});const outbox=service.enqueueWorkItemReport({sourceId,workspace:scope.workspace,bindingId:binding.id,idempotencyKey:key,text,itemId,reportRevision:1});reports.get(itemId)!.createdAt=outbox.createdAt;await service.tick();await service.whenIdle();return store.getOutbox(outbox.id)!}
 function envelope(eventId:string,text:string,providerMessageId='provider-1'){return{channel:'lark',account:'feedback',eventId,occurredAt:Date.now(),principal,conversation,kind:text.startsWith('/')?'command' as const:'text' as const,text,metadata:{replyToProviderMessageId:providerMessageId}}}
 const canonical=(itemId='P')=>evaluation.getTrustedWorkItemLearningProjection({scope:evaluation.canonicalHostScope(scope),itemId})
 const learning=(outcomeId:string)=>service.inspectOwnerWorkItemLearningTask({authorityId:authority.id,principalId:'lark/feedback/tenant/owner',workspace:scope.workspace,agentPreset:scope.preset,outcomeId})
 return{ctx,root,path,service,store,evaluation,binding,owner,registration,peer,reports,report,envelope,send,canonical,learning,setMaterial:(value:Readonly<WorkItemEngineeringMaterial>)=>{material=value},engineeringHook:(hook:(()=>void)|undefined)=>{engineeringHook=hook},batchHook:(hook:((itemId:string)=>void)|undefined)=>{batchHook=hook},ready:(value:boolean)=>{ready=value},current:(value:boolean)=>{current=value},resolverHook:(value:(()=>void)|undefined)=>{resolverHook=value},ownsHook:(value:(()=>void)|undefined)=>{ownsHook=value}}
}

const rawHash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
function sealMaterial(value:Omit<WorkItemEngineeringMaterial,'materialDigest'> & {materialDigest?:string}):Readonly<WorkItemEngineeringMaterial>{const {materialDigest:_old,...unsigned}=value;return{...unsigned,materialDigest:workItemReplyDigest(unsigned)}}
function route(f:Pick<Awaited<ReturnType<typeof fixture>>,'service'>){const owner=f.service.validateOwnerRoute({authorityId:authority.id,principalId:'lark/feedback/tenant/owner',workspace:scope.workspace,agentPreset:scope.preset});return{authorityId:owner.authorityId,principalId:owner.principalId,workspace:owner.workspace,agentPreset:owner.agentPreset,expectedOwner:{authorityHash:owner.authorityHash,principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion}}}
async function rootSource(f:Awaited<ReturnType<typeof fixture>>,text='原始任务 e\u0301\0 🧪',{attachments}:{attachments?:readonly InboundAttachmentDescriptor[];childText?:string}={}){
 const admitted=f.store.claimNativeInbox({envelope:{...f.envelope('engineering-root',text),metadata:{},...(attachments?{attachments}:{})},binding:f.binding,ownerLineage:f.owner,ownerId:'root-source',leaseMs:60000})
 const inboxId=admitted.record.id
 f.store.bindForegroundTaskExecution({inboxId,scope,owner:f.owner,binding:f.binding,dispatchedAt:Date.now()})
 f.store.recordForegroundExecutionModelSelection({inboxId,provider:'scripted',model:'frozen-model'})
 f.store.finishForegroundTaskExecution({inboxId,status:'unknown',quiescent:false,completedAt:Date.now(),termination:{protocol:'assistant-delivery/foreground-termination/v1',producer:'delivery-agent',kind:'error',causeCode:'runtime-error',handleDisposed:true,effects:'unknown',replay:'forbidden'}})
 f.store.finishInbox({inboxId,ownerId:'root-source',fencingToken:admitted.fencingToken!,outcome:'processed'})
 const source=f.service.inspectOwnerForegroundTaskSource({...route(f),inboxId})!
 const input:EngineeringRootInput={kind:'foreground',inboxId,sourceDigest:source.sourceDigest,executionRef:source.execution.executionRef,completionSequence:source.completionSequence,binding:{id:source.binding.id,version:source.binding.version,generation:source.binding.generation}}
 return{input,text,node:{itemId:'P',planProtocol:'assistant-work-items/foreground-diagnosis-plan/v1' as const,planDigest:'1'.repeat(64),input,parent:null}}
}
async function sentReport(f:Awaited<ReturnType<typeof fixture>>,itemId:string){let report=await f.report(itemId);for(let n=0;!report.providerMessageId&&n<3;n++){await f.service.tick();await f.service.whenIdle();report=f.store.getOutbox(report.id)!}expect(report.providerMessageId).toBeDefined();return report}
async function engineeringFixture(options:{child?:boolean;rootText?:string;attachments?:readonly InboundAttachmentDescriptor[];childText?:string}={}){
 const f=await fixture({continuation:true}),root=await rootSource(f,options.rootText,options.attachments?{attachments:options.attachments}:{})
 let itemId='P',nodes:EngineeringNode[]=[root.node],continuationInputs:WorkItemEngineeringMaterial['continuationInputs']=[],parentReports:WorkItemEngineeringMaterial['parentReports']=[],reply:ReturnType<DeliveryStore['workItemReplies']['read']>|undefined
 if(options.child){
  const parent=await sentReport(f,'P'),request=options.childText??'不同的主人续办请求 e\u0301\0 🧪'
  const accepted=await f.service.acceptInbound(f.envelope('engineering-child',request,parent.providerMessageId!));await f.service.whenIdle()
  reply=f.store.workItemReplies.pending({scope,owner:f.owner,limit:10}).find(row=>row.id===accepted.inboxId)!
  expect(reply).toBeDefined();f.store.workItemReplies.select({id:reply.id,expectedSourceDigest:reply.sourceDigest},()=>{})
  reply=f.store.workItemReplies.acknowledge({id:reply.id,expectedSourceDigest:reply.sourceDigest,childItemId:'C',childPlanDigest:'2'.repeat(64)},()=>{})
  const parentText=f.reports.get('P')!.text,fullTextDigest=rawHash(parentText)
  nodes.push({itemId:'C',planProtocol:'assistant-work-items/owner-continuation-plan/v2',planDigest:'2'.repeat(64),input:{kind:'continuation',sourceDigest:reply.sourceDigest,inputSha256:reply.inputSha256,inputBytes:reply.inputBytes,replyId:reply.id},parent:{itemId:'P',rootItemId:'P',report:{itemId:'P',revision:1,digest:'3'.repeat(64),fullTextDigest,fullBytes:Buffer.byteLength(parentText),status:'progress',truncated:false},outcomeRevision:1,productionDigest:'4'.repeat(64)}})
  continuationInputs=[{itemId:'C',text:request,fullTextDigest:rawHash(request),fullBytes:Buffer.byteLength(request)}];parentReports=[{itemId:'P',revision:1,text:parentText,fullTextDigest,fullBytes:Buffer.byteLength(parentText)}];itemId='C'
 }
 const report=await sentReport(f,itemId);await f.service.acceptInbound(f.envelope('engineering-feedback','还是不行',report.providerMessageId!));await f.service.whenIdle()
 const canonical=f.canonical(itemId)!,task=f.learning(canonical.objective!.outcomeId)!
 const material=sealMaterial({protocol:'assistant-work-items/engineering-material/v1',itemId,rootItemId:'P',feedbackProofDigest:task.proofIdentity.proofDigest,nodes,continuationInputs,parentReports})
 f.setMaterial(material)
 const locator:OwnerWorkItemEngineeringContextLocator={...route(f),itemId,outcomeId:canonical.objective!.outcomeId}
 const context=f.service.inspectOwnerWorkItemEngineeringContext(locator)
 const expectation=()=>{if(!context)throw new Error('no context');return{...locator,expectedSourceDigest:task.sourceDigest,expectedContentDigest:task.presentationDigest,canonical:{version:task.canonical.projection.version,digest:task.canonical.projection.digest,objectiveStatus:task.canonical.objective!.status as 'achieved'|'not-achieved'},expectedManifestDigest:context.manifest.manifestDigest,expectedObjectiveDigest:context.manifest.objective.fullTextDigest}}
 return{...f,directory:f.root,root,reply,material,task,locator,context,expectation}
}

describe('complete owner work-item engineering context',()=>{
 test('root and child objectives are exact authenticated inputs; reports and feedback remain background',async()=>{
  const f=await engineeringFixture({child:true});expect(f.context).toBeDefined()
  const source=f.service.withOwnerWorkItemEngineeringContextFence(f.expectation(),value=>value)
  const decoded=JSON.parse(source.objective) as {inputs:{text:string}[]}
  expect(decoded.inputs.map(row=>row.text)).toEqual([f.root.text,f.material.continuationInputs[0]!.text])
  expect(source.objective).toBe(acceptanceCanonicalJson({protocol:'work-item-owner-objective/v1',inputs:f.material.nodes.map((node,index)=>({itemId:node.itemId,source:node.input,text:index===0?f.root.text:f.material.continuationInputs[index-1]!.text}))}))
  expect(source.objective).not.toContain('还是不行');expect(source.objective).not.toContain('Report for P');expect(source.objective).not.toContain('Original task brief')
  expect(source.manifest.nodes).toHaveLength(2);expect(source.manifest.reports[0]!.revision).toBe(1)
  expect(f.service.readOwnerWorkItemEngineeringContext({...f.expectation(),selector:{kind:'parent-report',itemId:'P',revision:1}})?.text).toBe('Report for P')
  expect(f.service.readOwnerWorkItemEngineeringContext({...f.expectation(),selector:{kind:'parent-report',itemId:'P',revision:2}})).toBeUndefined()
 })
 test('the engineering producer and terminal consumer run under Delivery then Evaluation writer exclusion',async()=>{
  const f=await engineeringFixture({child:true})
  const locked=(path:string)=>sql(path,db=>{db.exec('PRAGMA busy_timeout=0');try{expect(()=>db.exec('BEGIN IMMEDIATE')).toThrow(/locked/)}finally{if(db.isTransaction)db.exec('ROLLBACK')}})
  f.engineeringHook(()=>{locked(f.path);locked(join(f.directory,'evaluation.sqlite'))})
  expect(f.service.withOwnerWorkItemEngineeringContextFence(f.expectation(),()=>{locked(f.path);locked(join(f.directory,'evaluation.sqlite'));return 'local-ledger'})).toBe('local-ledger')
 })
 test('foreign owner and forged historical root locators cannot borrow current feedback authority',async()=>{
  const f=await engineeringFixture()
  expect(f.service.inspectOwnerWorkItemEngineeringContext({...f.locator,expectedOwner:{...f.locator.expectedOwner,principalVersion:f.locator.expectedOwner.principalVersion+1}})).toBeUndefined()
  for(const change of [{completionSequence:f.root.input.completionSequence+1},{executionRef:'different-inbox'},{binding:{...f.root.input.binding,generation:f.root.input.binding.generation+1}},{sourceDigest:'0'.repeat(64)}]){
   f.setMaterial(sealMaterial({...f.material,nodes:[{...f.material.nodes[0]!,input:{...f.root.input,...change}}]}))
   expect(f.service.inspectOwnerWorkItemEngineeringContext(f.locator)).toBeUndefined()
  }
 })
 test('same owner new Session reads sealed child history while old execution source read still rejects cancellation',async()=>{
  const f=await engineeringFixture({child:true}),expectation=f.expectation(),source={id:f.reply!.id,expectedSourceDigest:f.reply!.sourceDigest}
  await f.service.acceptInbound(f.envelope('engineering-new','/new'));await f.service.whenIdle()
  expect(()=>f.store.workItemReplies.read(source)).toThrow(/cancelled/)
  expect(f.store.workItemReplies.inspectHistoricalSource(source)).toMatchObject({state:'cancelled',child:{itemId:'C',planDigest:'2'.repeat(64)}})
  expect(f.service.inspectOwnerWorkItemEngineeringContext({...f.locator,...route(f)})?.manifest).toEqual(f.context!.manifest)
  expect(f.service.withOwnerWorkItemEngineeringContextFence({...expectation,...route(f)},value=>value.manifest.manifestDigest)).toBe(expectation.expectedManifestDigest)
 })
 test.each([{rootText:''},{rootText:' \t\n'},{rootText:'',attachments:[{resourceType:'image' as const,providerRef:'image-only'}]},{rootText:'text plus attachment',attachments:[{resourceType:'file' as const,providerRef:'file-with-text'}]}])('abstains from incomplete root input %#',async options=>{const f=await engineeringFixture(options);expect(f.context).toBeUndefined()})
 test('exact UTF8 pages preserve decomposed Unicode and NUL and recheck the last page',async()=>{
  const f=await engineeringFixture({child:true}),expected=f.expectation();let offset=0,text=''
  for(;;){const page=f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'},offset,maxBytes:7})!;expect(page).toBeDefined();expect(page.offset).toBe(offset);text+=page.text;if(page.nextOffset===undefined)break;offset=page.nextOffset}
  expect(rawHash(text)).toBe(expected.expectedObjectiveDigest);expect(JSON.parse(text).inputs[0].text).toBe(f.root.text)
  const bytes=Buffer.from(text),boundary=bytes.indexOf(Buffer.from('🧪'))
  expect(boundary).toBeGreaterThan(0);expect(f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'},offset:boundary+1,maxBytes:4})).toBeUndefined()
  f.setMaterial(sealMaterial({...f.material,nodes:[{...f.material.nodes[0]!,planDigest:'5'.repeat(64)},...f.material.nodes.slice(1)]}))
  expect(f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'},offset:bytes.length,maxBytes:4})).toBeUndefined()
 })
 test('a later unselected parent report does not replace sealed background bytes',async()=>{
  const f=await engineeringFixture({child:true});f.reports.get('P')!.text='Later parent report that was not selected'
  expect(f.service.inspectOwnerWorkItemEngineeringContext(f.locator)?.manifest.manifestDigest).toBe(f.context!.manifest.manifestDigest)
  expect(f.service.readOwnerWorkItemEngineeringContext({...f.expectation(),selector:{kind:'parent-report',itemId:'P',revision:1}})?.text).toBe('Report for P')
 })
 test.each(['correct','withdraw'] as const)('feedback %s invalidates frozen engineering source',async action=>{
  const f=await engineeringFixture(),expected=f.expectation()
  await f.service.acceptInbound(f.envelope('engineering-'+action,action==='correct'?'问题解决了':'/feedback withdraw 1 not-achieved'));await f.service.whenIdle()
  expect(f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'}})).toBeUndefined()
  expect(()=>f.service.withOwnerWorkItemEngineeringContextFence(expected,()=>true)).toThrow(/unavailable or changed/)
 })
 test('missing new peer capability never falls back to the older learning or proof interface',async()=>{
  const f=await engineeringFixture(),peer=f.ctx.get('assistantWorkItems' as never) as unknown as {resolveOwnerWorkItemEngineeringTarget?:unknown}
  delete peer.resolveOwnerWorkItemEngineeringTarget
  expect(f.service.inspectOwnerWorkItemEngineeringContext(f.locator)).toBeUndefined();expect(f.learning(f.locator.outcomeId)).toEqual(f.task)
 })
 test.each(['policy','producer','root'] as const)('last engineering callback %s drift prevents consumer and rolls back source mutation',async kind=>{
  const f=await engineeringFixture({child:true}),expected=f.expectation(),consumer=vi.fn();let hit=false
  f.engineeringHook(()=>{hit=true;if(kind==='policy')f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'engineering final callback'})
   else if(kind==='producer')f.current(false)
   else (f.store as unknown as{database:DatabaseSync}).database.prepare('UPDATE inbox_messages SET envelope_hash=? WHERE id=?').run('0'.repeat(64),f.root.input.inboxId)
  })
  expect(()=>f.service.withOwnerWorkItemEngineeringContextFence(expected,consumer)).toThrow();expect(hit).toBe(true);expect(consumer).not.toHaveBeenCalled()
  if(kind==='root'){f.engineeringHook(undefined);expect(f.service.inspectOwnerWorkItemEngineeringContext(f.locator)?.manifest.manifestDigest).toBe(expected.expectedManifestDigest)}
 })
 test('consumer errors and thenables reject under both writer locks and leave old Memory proof bytes unchanged',async()=>{
  const f=await engineeringFixture(),before=JSON.stringify(f.learning(f.locator.outcomeId)),error=new Error('terminal ledger failure')
  expect(()=>f.service.withOwnerWorkItemEngineeringContextFence(f.expectation(),()=>{throw error})).toThrow(error)
  expect(()=>f.service.withOwnerWorkItemEngineeringContextFence(f.expectation(),()=>Promise.resolve('async'))).toThrow(/synchronous/)
  expect(JSON.stringify(f.learning(f.locator.outcomeId))).toBe(before)
 })
 test('full canonical objective limits include framing and reject oversize roots without truncation',async()=>{const f=await engineeringFixture({rootText:'a'.repeat(16384)});expect(f.context).toBeUndefined()})
 test('wrong child plan or unacknowledged real replies cannot form an engineering frame',async()=>{
  const f=await engineeringFixture({child:true}),expected=f.expectation()
  f.setMaterial(sealMaterial({...f.material,nodes:[f.material.nodes[0]!,{...f.material.nodes[1]!,planDigest:'8'.repeat(64)}]}))
  expect(f.service.inspectOwnerWorkItemEngineeringContext(f.locator)).toBeUndefined()
  expect(f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'}})).toBeUndefined()
  const childReport=f.store.getOutboxByIdempotencyKey('report:C')!
  const accepted=await f.service.acceptInbound(f.envelope('unfinished-child','new unacknowledged request',childReport.providerMessageId!));await f.service.whenIdle()
  const pending=f.store.workItemReplies.pending({scope,owner:f.owner,limit:10}).find(row=>row.id===accepted.inboxId)!
  expect(pending).toBeDefined();expect(f.store.workItemReplies.inspectHistoricalSource({id:pending.id,expectedSourceDigest:pending.sourceDigest})).toBeUndefined()
 })
 test.each(['body','attachment'] as const)('corrupt original child %s remains unavailable even with recomputed envelope hash',async kind=>{
  const f=await engineeringFixture({child:true}),expected=f.expectation(),inbox=f.store.getInbox(f.reply!.id)!,db=(f.store as unknown as{database:DatabaseSync}).database
  const envelope=kind==='body'?{...inbox.envelope,text:'different original input'}:{...inbox.envelope,attachments:[{resourceType:'image',providerRef:'tampered-image'}]}
  const text=JSON.stringify(envelope);db.prepare('UPDATE inbox_messages SET envelope_json=?,envelope_hash=? WHERE id=?').run(text,rawHash(text),inbox.id)
  expect(f.service.readOwnerWorkItemEngineeringContext({...expected,selector:{kind:'objective'}})).toBeUndefined()
 })
 test('whitespace-only authenticated child input cannot silently become a framed engineering objective',async()=>{const f=await engineeringFixture({child:true,childText:' \t\n'});expect(f.context).toBeUndefined()})

})

describe('engineering material bounds and inert parsing',()=>{
 function chain(links:number):Readonly<WorkItemEngineeringMaterial>{
  const root:EngineeringNode={itemId:'P',planProtocol:'assistant-work-items/foreground-diagnosis-plan/v1',planDigest:'1'.repeat(64),input:{kind:'foreground',inboxId:'inbox-root',sourceDigest:'2'.repeat(64),executionRef:'inbox-root',completionSequence:1,binding:{id:'binding',version:1,generation:1}},parent:null}
  const nodes:EngineeringNode[]=[root],continuationInputs:{itemId:string;text:string;fullTextDigest:string;fullBytes:number}[]=[]
  for(let n=1;n<=links;n++){const itemId=`C${n}`;nodes.push({itemId,planProtocol:'assistant-work-items/owner-continuation-plan/v2',planDigest:'3'.repeat(64),input:{kind:'continuation',sourceDigest:'4'.repeat(64),inputSha256:rawHash('request'),inputBytes:7,replyId:`reply${n}`},parent:{itemId:nodes[n-1]!.itemId,rootItemId:'P',report:null,outcomeRevision:null,productionDigest:'5'.repeat(64)}});continuationInputs.push({itemId,text:'request',fullTextDigest:rawHash('request'),fullBytes:7})}
  return sealMaterial({protocol:'assistant-work-items/engineering-material/v1',itemId:nodes.at(-1)!.itemId,rootItemId:'P',feedbackProofDigest:'6'.repeat(64),nodes,continuationInputs,parentReports:[]})
 }
 test('32 links accepted; 33, cycles, missing bodies and legacy child provenance rejected',()=>{
  expect(validateWorkItemEngineeringMaterial(chain(32)).nodes).toHaveLength(33);expect(()=>validateWorkItemEngineeringMaterial(chain(33))).toThrow()
  const base=chain(1)
  for(const value of [sealMaterial({...base,nodes:[base.nodes[0]!,{...base.nodes[1]!,itemId:'P'}]}),sealMaterial({...base,continuationInputs:[]}),sealMaterial({...base,nodes:[base.nodes[0]!,{...base.nodes[1]!,planProtocol:'assistant-work-items/owner-continuation-plan/v1',input:{kind:'continuation',sourceDigest:'4'.repeat(64),inputSha256:rawHash('request'),inputBytes:7}}]})])expect(()=>validateWorkItemEngineeringMaterial(value)).toThrow()
 })
 test('enforces individual and total report/input limits plus escaped canonical byte limits',()=>{
  const reports=(count:number,text:string)=>{
   const material=chain(count),nodes=[...material.nodes],parentReports=[]
   for(let index=1;index<nodes.length;index++){
    const node=nodes[index]!,itemId=nodes[index-1]!.itemId,fullTextDigest=rawHash(text),fullBytes=Buffer.byteLength(text)
    nodes[index]={...node,parent:{...node.parent!,report:{itemId,revision:1,digest:'7'.repeat(64),fullTextDigest,fullBytes,status:'waiting',truncated:false}}}
    parentReports.push({itemId,revision:1,text,fullTextDigest,fullBytes})
   }
   return sealMaterial({...material,nodes,parentReports})
  }
  expect(validateWorkItemEngineeringMaterial(reports(4,'r'.repeat(65536))).parentReports).toHaveLength(4)
  expect(()=>validateWorkItemEngineeringMaterial(reports(1,'r'.repeat(65537)))).toThrow()
  expect(()=>validateWorkItemEngineeringMaterial(reports(5,'r'.repeat(65536)))).toThrow()
  expect(()=>validateWorkItemEngineeringMaterial(reports(2,'\0'.repeat(65536)))).toThrow()
  const material=chain(2),text='q'.repeat(8193),continuationInputs=material.continuationInputs.map(row=>({...row,text,fullBytes:Buffer.byteLength(text),fullTextDigest:rawHash(text)}))
  const nodes=material.nodes.map((node,index)=>index===0?node:{...node,input:{...node.input,kind:'continuation' as const,inputBytes:8193,inputSha256:rawHash(text)}})
  expect(()=>validateWorkItemEngineeringMaterial(sealMaterial({...material,nodes,continuationInputs}))).toThrow()
 })
 test('rejects accessors without invoking them, digest drift, malformed UTF8 and extra fields',()=>{
  const valid=chain(0);let gets=0;const accessor={...valid};Object.defineProperty(accessor,'nodes',{enumerable:true,get:()=>{gets++;return valid.nodes}})
  expect(()=>validateWorkItemEngineeringMaterial(accessor)).toThrow();expect(gets).toBe(0)
  expect(()=>validateWorkItemEngineeringMaterial({...valid,extra:true})).toThrow();expect(()=>validateWorkItemEngineeringMaterial({...valid,materialDigest:'0'.repeat(64)})).toThrow()
  expect(()=>frameWorkItemEngineeringContext(valid,'\ud800')).toThrow()
 })
})
