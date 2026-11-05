import {Context,Service} from '@deepseek-ai/cordis'
import {AssistantPolicyService} from '@dsh-enhanced/assistant-policy'
import {AssistantEvaluationService} from '@dsh-enhanced/assistant-evaluation'
import type {TrustedWorkItemEvaluationRegistration,TrustedWorkItemOwnerFeedbackProof,OutcomeEnvelope,OwnerObjectiveCommand,StoredOutcome} from '@dsh-enhanced/assistant-evaluation'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
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
function currentTestStack():string{const old=Error.stackTraceLimit;try{Error.stackTraceLimit=50;return new Error().stack??''}finally{Error.stackTraceLimit=old}}
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
 // Delivery settles its own work, but Evaluation projects trusted outcomes asynchronously
 // and can still append a receipt-driven fact on a later turn of the event loop. Every
 // reader here validates an exact projection digest, so drain both lanes to quiescence.
 const settle=async()=>{for(let round=0;round<6;round++){await service.tick();await service.whenIdle();await evaluation.reconcileProjections();await evaluation.whenProjectionIdle();await new Promise<void>(resolve=>setTimeout(resolve,1))}}
 async function report(itemId='P',streamId=itemId){const target:WorkItemReportTarget={protocol:'assistant-delivery/work-item-report/v1',itemId,reportRevision:1,streamId,reportDigest:workItemReplyDigest(['report',itemId]),sourceId,scope,owner};const text=`Report for ${itemId}`,key=`report:${itemId}`;reports.set(itemId,{target,bindingId:binding.id,text,key,createdAt:Date.now()});const outbox=service.enqueueWorkItemReport({sourceId,workspace:scope.workspace,bindingId:binding.id,idempotencyKey:key,text,itemId,reportRevision:1});reports.get(itemId)!.createdAt=outbox.createdAt;await service.tick();await settle();return store.getOutbox(outbox.id)!}
 function envelope(eventId:string,text:string,providerMessageId='provider-1'){return{channel:'lark',account:'feedback',eventId,occurredAt:Date.now(),principal,conversation,kind:text.startsWith('/')?'command' as const:'text' as const,text,metadata:{replyToProviderMessageId:providerMessageId}}}
 const canonical=(itemId='P')=>evaluation.getTrustedWorkItemLearningProjection({scope:evaluation.canonicalHostScope(scope),itemId})
 const learning=(outcomeId:string)=>service.inspectOwnerWorkItemLearningTask({authorityId:authority.id,principalId:'lark/feedback/tenant/owner',workspace:scope.workspace,agentPreset:scope.preset,outcomeId})
 return{ctx,root,path,service,store,evaluation,binding,owner,registration,peer,reports,report,settle,envelope,send,canonical,learning,batchHook:(hook:((itemId:string)=>void)|undefined)=>{batchHook=hook},ready:(value:boolean)=>{ready=value},current:(value:boolean)=>{current=value},resolverHook:(value:(()=>void)|undefined)=>{resolverHook=value},ownsHook:(value:(()=>void)|undefined)=>{ownsHook=value}}
}

describe('owner work-item result feedback through real Delivery and Evaluation',()=>{
 test.each(['问题解决了','还是不行'])('records %s without any foreground execution or continuation admission',async text=>{
  const f=await fixture({continuation:true});await f.report();const envelope=f.envelope('result',text),input=await f.service.acceptInbound(envelope);await f.settle()
  expect(input.status).toBe('processed');expect(await f.service.acceptInbound(envelope)).toEqual({...input,duplicate:true})
  const canonical=f.canonical()!;expect(canonical.projection.subjectKind).toBe('work-item');expect(canonical.objective?.status).toBe(text==='问题解决了'?'achieved':'not-achieved');expect(canonical.execution?.status).toBe('failed')
  expect(f.store.workItemFeedback.get(input.inboxId)).toMatchObject({state:'recorded',canonical:{version:1,outcomeId:canonical.objective!.outcomeId}})
  sql(f.path,db=>{expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM delivery_foreground_executions').get()?.n).toBe(0)})
  expect(f.store.claimInbox({ownerId:'foreground',leaseMs:1000,limit:20,maxAttempts:3})).toEqual([])
  const learning=f.learning(canonical.objective!.outcomeId)!;expect(learning).toMatchObject({protocol:'assistant-delivery/owner-work-item-learning/v1',judgement:'owner-feedback',proofIdentity:{production:{executionStatus:'failed'}},presentation:{feedback:{text}}});expect(learning.proofIdentity).not.toHaveProperty('task');expect(learning.proofIdentity).not.toHaveProperty('report')
 })
 test('holds durable feedback while production is not quiescent, then records without entering continuation',async()=>{
  const f=await fixture({continuation:true});await f.report();f.ready(false);const input=await f.service.acceptInbound(f.envelope('waiting','还是不行'));await f.settle()
  expect(f.store.workItemFeedback.get(input.inboxId)?.state).toBe('pending');expect(f.canonical()).toBeUndefined()
  f.ready(true);await f.service.tick();await f.settle();expect(f.canonical()?.objective?.status).toBe('not-achieved')
  sql(f.path,db=>expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(0))
 })
 test('freezes natural CAS, corrects and withdraws the original item, and invalidates old learning reads',async()=>{
  const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('first','还是不行'));await f.settle();const first=f.canonical()!,source=f.learning(first.objective!.outcomeId)!;expect(source).toBeDefined()
  await f.service.acceptInbound(f.envelope('correct','问题解决了'));await f.settle();const corrected=f.canonical()!;expect(corrected.objective?.status).toBe('achieved');expect(f.learning(first.objective!.outcomeId)).toBeUndefined()
  expect(f.learning(corrected.objective!.outcomeId)?.ownerRevision).toMatchObject({version:2,action:'correct'})
  await f.service.acceptInbound(f.envelope('withdraw','/feedback withdraw 2 achieved'));await f.settle();expect(f.canonical()?.objective?.status).toBe('unknown');expect(f.learning(corrected.objective!.outcomeId)).toBeUndefined()
 })
 test('status with no vote is acknowledged without fabricating a canonical owner revision',async()=>{
  const f=await fixture();await f.report();const status=await f.service.acceptInbound(f.envelope('status','/feedback status'));await f.settle();const intent=f.store.workItemFeedback.get(status.inboxId)!
  expect(intent).toMatchObject({state:'recorded',canonical:{version:0,objectiveStatus:'unknown'}});expect(f.canonical()?.objective).toBeUndefined()
  const ack=f.store.getOutboxByIdempotencyKey(`feedback:${status.inboxId}:ack`)!;expect(ack.intent.text).toContain('暂无已记录反馈');await f.service.tick();await f.settle();expect(f.store.getOutbox(ack.id)?.status).toBe('accepted')
 })
 test('recovers canonical append after lost local ACK and cold reopening without another vote or source rewrite',async()=>{
  const f=await fixture();await f.report();sql(f.path,db=>db.exec("CREATE TRIGGER test_lost_feedback_ack BEFORE UPDATE OF state ON delivery_work_item_feedback WHEN NEW.state='recorded' BEGIN SELECT RAISE(ABORT,'lost local ACK'); END"))
  const accepted=await f.service.acceptInbound(f.envelope('lost','还是不行'));await f.settle();expect(f.store.workItemFeedback.get(accepted.inboxId)?.state).toBe('frozen');const first=f.canonical()!;expect(first.objective).toBeDefined();sql(f.path,db=>db.exec('DROP TRIGGER test_lost_feedback_ack'));await f.ctx.fiber.dispose()
  const next=await fixture({root:f.root});await next.service.tick();await next.settle();expect(next.store.workItemFeedback.get(accepted.inboxId)).toMatchObject({state:'recorded',canonical:{version:1,outcomeId:first.objective!.outcomeId}});expect(next.canonical()?.objective?.outcomeId).toBe(first.objective!.outcomeId)
 })
 test.each(['/stop','/new','/clear'])('cancels pending feedback before %s and never revives it',async command=>{
  const f=await fixture();await f.report();f.ready(false);const old=await f.service.acceptInbound(f.envelope('pending','还是不行'));await f.settle();await f.service.acceptInbound(f.envelope('boundary',command));f.ready(true);await f.service.tick();await f.settle();expect(f.store.workItemFeedback.get(old.inboxId)?.state).toBe('cancelled');expect(f.canonical()).toBeUndefined()
 })
 test('retains sourceDigest across a new session for recorded same-owner feedback',async()=>{
  const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('record','还是不行'));await f.settle();const canonical=f.canonical()!,before=f.learning(canonical.objective!.outcomeId)!;expect(before).toBeDefined();await f.service.acceptInbound(f.envelope('new','/new'));const after=f.learning(canonical.objective!.outcomeId)!;expect(after.sourceDigest).toBe(before.sourceDigest);expect(after.owner.generation).toBeGreaterThan(before.owner.generation);expect(after.proofIdentity.originBindingId).toBe(before.proofIdentity.originBindingId)
 })
 test.each([false,true])('feedback disabled=%s preserves ordinary continuation; feedback policy denial never starts a worker',async disabled=>{
  const f=await fixture({feedback:!disabled,continuation:true,allowFeedback:false});await f.report();const input=await f.service.acceptInbound(f.envelope('not-authorized','还是不行'));await f.settle();expect(input.status).toBe(disabled?'processed':'queued');sql(f.path,db=>{expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_feedback').get()?.n).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(disabled?1:0)})
 })
 test('feedback-only registration does not grant continuation, while continuation expiry does not block feedback',async()=>{
  const f=await fixture();await f.report();expect((await f.service.acceptInbound(f.envelope('ordinary','do more'))).status).toBe('queued')
  await f.service.acceptInbound(f.envelope('result','问题解决了'));await f.settle();expect(f.canonical()?.objective?.status).toBe('achieved')
 })
 test('rejects learning evidence withdrawn by the final ownership callback after canonical reads',async()=>{
  const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('owner-before-race','还是不行'));await f.settle()
  const initial=f.canonical()!,outcomeId=initial.objective!.outcomeId,scopeToken=f.evaluation.canonicalHostScope(scope)
  const old=f.evaluation.getTrustedOutcome({scope:scopeToken,outcomeId})!,store=(f.evaluation as unknown as{store:{append(input:OutcomeEnvelope,command:OwnerObjectiveCommand):StoredOutcome}}).store
  let ownsCalls=0
  f.ownsHook(()=>{if(currentTestStack().includes('inspectOwnerWorkItemLearningTask'))ownsCalls++})
  expect(f.learning(outcomeId)).toBeDefined();const lastOwns=ownsCalls;expect(lastOwns).toBeGreaterThan(0)
  let withdrew=false;ownsCalls=0
  f.ownsHook(()=>{
   if(!currentTestStack().includes('inspectOwnerWorkItemLearningTask') || ++ownsCalls!==lastOwns)return
   withdrew=true
   store.append({scope,situation:old.situation,executionStatus:old.executionStatus,objectiveStatus:'unknown',deliveryStatus:old.deliveryStatus,source:old.source,trust:'trusted',evidence:old.evidence,metrics:{},occurredAt:old.occurredAt+1,idempotencyKey:'reentrant-reader-withdraw',evaluator:old.evaluator},
    {...f.owner,operationId:'reentrant-reader-withdraw',action:'withdraw',expectedVersion:1,previousStatus:'not-achieved'})
  })
  const source=f.learning(outcomeId)
  console.log('READER_LAST_OWNS_OBSERVATION',JSON.stringify({withdrew,current:f.canonical()?.objective?.status,returnedVersion:source?.ownerRevision.version}))
  expect(withdrew).toBe(true);expect(f.canonical()?.objective?.status).toBe('unknown');expect(source).toBeUndefined()
 })
 test.each(['before-transaction','inside-transaction'] as const)('rejects a production proof invalidated by writer ownership callback %s',async phase=>{
  const f=await fixture();await f.report();let changed=false
  f.ownsHook(()=>{
   const stack=currentTestStack(),inside=stack.includes('withOwnerWriterFence')
   if(changed || !stack.includes('withOwnerWorkItemFeedbackWriterFence') || inside!==(phase==='inside-transaction'))return
   changed=true;f.ready(false)
  })
  const accepted=await f.service.acceptInbound(f.envelope(`writer-owns-${phase}`,'还是不行'));await f.settle()
  console.log('WRITER_LAST_OWNS_OBSERVATION',JSON.stringify({phase,changed,canonicalStatus:f.canonical()?.objective?.status,state:f.store.workItemFeedback.get(accepted.inboxId)?.state}))
  expect(changed).toBe(true);expect(f.canonical()?.objective?.source.kind).not.toBe('user-feedback')
 })
 test('checks real Policy revoked inside the final Delivery writer production resolve',async()=>{
  const f=await fixture();await f.report();let finalResolve=false
  f.resolverHook(()=>{if(currentTestStack().includes('withOwnerWorkItemFeedbackWriterFence')){finalResolve=true;f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'final writer production resolve'})}})
  const accepted=await f.service.acceptInbound(f.envelope('writer-final-policy','还是不行'));await f.settle()
  expect(finalResolve).toBe(true);expect(f.ctx.assistantPolicy.getEmergencyStop().enabled).toBe(true)
  expect(f.canonical()?.objective?.source.kind).not.toBe('user-feedback');expect(f.store.workItemFeedback.get(accepted.inboxId)?.state).toBe('frozen')
 })
 test('rejects Policy revoked by the final Evaluation WorkItems resolve before an owner vote is written',async()=>{
  const f=await fixture();await f.report();let resolves=0
  f.resolverHook(()=>{if(++resolves===6)f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'last Evaluation resolver revoked feedback'})})
  const accepted=await f.service.acceptInbound(f.envelope('last-resolve','还是不行'));await f.settle()
  expect(resolves).toBeGreaterThanOrEqual(6)
  const policy=f.ctx.assistantPolicy.evaluate({subject:{kind:'external',id:'lark/feedback/tenant/owner',workspace:scope.workspace,principal:'lark/feedback/tenant/owner'},action:'feedback-work-items',resource:{kind:'automation',id:automationId},context:{initiator:'external'}})
  const canonical=f.canonical();console.log('FINAL_RESOLVE_POLICY_OBSERVATION',JSON.stringify({policy:policy.effect,canonical,source:f.store.workItemFeedback.get(accepted.inboxId)?.state}))
  expect(policy.effect).toBe('deny');expect(canonical?.objective?.source.kind).not.toBe('user-feedback')
 })
 test('preserves mixed negative feedback plus explicit further instructions as an ordinary continuation request',async()=>{
  const f=await fixture({continuation:true});await f.report();const input=await f.service.acceptInbound(f.envelope('mixed','还是不行，继续修复'));await f.settle();expect(input.status).toBe('processed');expect(f.canonical()).toBeUndefined()
  sql(f.path,db=>{expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_feedback').get()?.n).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(1)})
 })
 test('uses the exact original report item instead of the continuation stream head for feedback',async()=>{
  const f=await fixture({continuation:true});await f.report();await f.service.acceptInbound(f.envelope('continue','do more'));const source=f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:10}).items[0]!,input={id:source.id,expectedSourceDigest:source.sourceDigest}
  f.service.selectWorkItemReplyParent(input);f.service.acknowledgeWorkItemReply({...input,childItemId:'C1',childPlanDigest:'c'.repeat(64)})
  await f.service.acceptInbound(f.envelope('result-original','问题解决了'));await f.settle();expect(f.canonical('P')?.objective?.status).toBe('achieved');expect(f.canonical('C1')).toBeUndefined()
 })
 test('separates expired continuation permission from still-authorized report feedback',async()=>{
  const f=await fixture({continuation:true});await f.report();const canContinue=vi.fn(()=>false);Object.assign(f.registration,{canContinueReport:canContinue})
  expect((await f.service.acceptInbound(f.envelope('expired','do more'))).status).toBe('queued');const before=canContinue.mock.calls.length
  await f.service.acceptInbound(f.envelope('feedback-expired','还是不行'));await f.settle();expect(f.canonical()?.objective?.status).toBe('not-achieved');expect(canContinue).toHaveBeenCalledTimes(before)
 })
 test('never puts an exclusive continuation source back into foreground when its live continuation grant expires',async()=>{
  const f=await fixture({continuation:true});await f.report();const input=await f.service.acceptInbound(f.envelope('exclusive','do more'));const source=f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:10}).items[0]!
  Object.assign(f.registration,{canContinueReport:()=>false});expect(()=>f.service.readWorkItemReply({id:source.id,expectedSourceDigest:source.sourceDigest})).toThrow();expect(f.store.getInbox(input.inboxId)?.status).toBe('processed')
 })
 test('keeps an unknown user acknowledgement in its original Outbox without blindly re-enqueueing',async()=>{
  const f=await fixture({unknownAck:true});await f.report();const input=await f.service.acceptInbound(f.envelope('unknown-ack','问题解决了'));await f.settle();await f.service.tick();await f.settle()
  const key=`feedback:${input.inboxId}:ack`,ack=f.store.getOutboxByIdempotencyKey(key)!;expect(ack.status).toBe('unknown_after_send');const sends=f.send.mock.calls.length
  await f.service.tick();await f.settle();expect(f.store.getOutboxByIdempotencyKey(key)?.id).toBe(ack.id);expect(f.send).toHaveBeenCalledTimes(sends)
 })
 test('rechecks real Policy after opaque WorkItems callbacks before any owner append',async()=>{
  const f=await fixture();await f.report();f.resolverHook(()=>f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'reentrant revoke'}));const input=await f.service.acceptInbound(f.envelope('revoked','还是不行'));await f.settle();expect(f.canonical()).toBeUndefined();expect(f.store.workItemFeedback.get(input.inboxId)?.state).toBe('pending')
 })
})


test('preserves genuine populated schema29 reports, reply input, ACK and stream head when adding schema30',async()=>{
 const root=await mkdtemp(join(tmpdir(),'genuine-delivery-v29-migration-'));roots.push(root);const path=join(root,'state.sqlite')
 const schema=await readFile(new URL('./fixtures/delivery-v29-populated.sql',import.meta.url),'utf8')
 const before=sql(path,db=>{db.exec(schema);expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(29)
  const tables=(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name)
  return{schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),tables:Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name}"`).all()])),source:db.prepare('SELECT source_digest,source_json,execution_parent_item_id,child_item_id,child_plan_digest,state FROM delivery_work_item_replies').get(),head:db.prepare('SELECT * FROM delivery_work_item_reply_streams').get()}})
 const store=new DeliveryStore({path});store.close();const reopened=new DeliveryStore({path});reopened.close()
 sql(path,db=>{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(31);const oldNames=new Set(before.schema.map(row=>row.name));expect(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all().filter(row=>oldNames.has(row.name))).toEqual(before.schema)
  for(const[name,rows]of Object.entries(before.tables))expect(db.prepare(`SELECT * FROM "${name}"`).all()).toEqual(rows)
  expect(db.prepare('SELECT source_digest,source_json,execution_parent_item_id,child_item_id,child_plan_digest,state FROM delivery_work_item_replies').get()).toEqual(before.source)
  expect(db.prepare('SELECT * FROM delivery_work_item_reply_streams').get()).toEqual(before.head);expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_feedback').get()?.n).toBe(0)})
})


describe('work-item Memory source fences',()=>{
 const scopeInput=(task:NonNullable<ReturnType<AssistantDeliveryService['inspectOwnerWorkItemLearningTask']>>)=>({authorityId:task.owner.authorityId,principalId:task.owner.principalId,
  workspace:task.owner.workspace,agentPreset:task.owner.agentPreset,expectedOwner:{authorityHash:task.owner.authorityHash,principalRecordId:task.owner.principalRecordId,principalVersion:task.owner.principalVersion}})
 const expectation=(task:NonNullable<ReturnType<AssistantDeliveryService['inspectOwnerWorkItemLearningTask']>>)=>({kind:'work-item' as const,itemId:task.proofIdentity.itemId,
  outcomeId:task.canonical.objective!.outcomeId,expectedSourceDigest:task.sourceDigest,expectedContentDigest:task.presentationDigest,
  canonical:{version:task.canonical.projection.version,digest:task.canonical.projection.digest,objectiveStatus:task.canonical.objective!.status as 'achieved'|'not-achieved'}})
 async function recorded(f:Awaited<ReturnType<typeof fixture>>,itemId='P'){
  let report=await f.report(itemId)
  for(let attempt=0;report.providerMessageId===undefined&&attempt<3;attempt++){await f.service.tick();await f.settle();report=f.store.getOutbox(report.id)!}
  expect(report.providerMessageId).toBeDefined()
  await f.service.acceptInbound(f.envelope(`result-${itemId}`,'还是不行',report.providerMessageId!));await f.settle()
  return f.learning(f.canonical(itemId)!.objective!.outcomeId)!
 }
 test('strict exact single wrapper holds native locks, preserves identity, and rejects stale source or thenable',async()=>{
  const f=await fixture(),task=await recorded(f),input={...scopeInput(task),...expectation(task)},callback=vi.fn(value=>value)
  expect(f.service.withOwnerWorkItemLearningTaskFence(input,callback)).toEqual(task);expect(callback).toHaveBeenCalledOnce();expect(Object.isFrozen(callback.mock.results[0]!.value.proofIdentity.production)).toBe(true)
  expect(()=>f.service.withOwnerWorkItemLearningTaskFence({...input,expectedContentDigest:'c'.repeat(64)},callback)).toThrow(/unavailable or changed/)
  expect(callback).toHaveBeenCalledOnce()
  expect(()=>f.service.withOwnerWorkItemLearningTaskFence(input,()=>Promise.resolve('async'))).toThrow(/synchronous/)
  expect(f.service.withOwnerWorkItemLearningTaskFence(input,()=>17)).toBe(17)
 })
 test('mixed real foreground fact preserves legacy content bytes and needs no invented canonical result',async()=>{
  const f=await fixture(),task=await recorded(f),base=scopeInput(task)
  const admitted=f.store.claimNativeInbox({envelope:{...f.envelope('foreground-fact','owner fact'),metadata:{}},binding:f.binding,ownerLineage:f.owner,ownerId:'fact-worker',leaseMs:60000})
  const inboxId=admitted.record.id
  f.store.bindForegroundTaskExecution({inboxId,scope,owner:f.owner,binding:f.binding,dispatchedAt:Date.now()})
  f.store.recordForegroundExecutionModelSelection({inboxId,provider:'scripted',model:'fact-model'})
  f.store.finishForegroundTaskExecution({inboxId,status:'succeeded',quiescent:true,completedAt:Date.now()})
  f.store.enqueue({idempotencyKey:`inbound:${inboxId}:reply`,bindingId:f.binding.id,target:{principal,conversation},text:'actual foreground reply',replyToEventId:'foreground-fact'})
  const source=f.service.inspectOwnerForegroundTaskSource({...base,inboxId})!,legacy=f.service.withOwnerForegroundTaskSourceFence({...base,inboxId,expectedSourceDigest:source.sourceDigest},value=>value)
  const snapshots=f.service.withOwnerLearningSourcesFence({...base,sources:[{kind:'foreground',inboxId,expectedSourceDigest:source.sourceDigest},expectation(task)]},value=>value)
  const foreground=snapshots[0]!
  if(foreground.kind!=='foreground')throw new Error('wrong index')
  expect(foreground.content).toEqual(legacy);expect(JSON.stringify(foreground.content)).toBe(JSON.stringify(legacy));expect(foreground.currentCanonical).toBeUndefined();expect(foreground.task).toBeUndefined()
  expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.task?.sourceDigest).toBe(task.sourceDigest)
 })
 test('holds Delivery and canonical SQLite writer locks together through the terminal ledger callback',async()=>{
  const f=await fixture(),task=await recorded(f)
  const locked=(path:string)=>sql(path,db=>{db.exec('PRAGMA busy_timeout=0');try{expect(()=>db.exec('BEGIN IMMEDIATE')).toThrow(/locked/)}finally{if(db.isTransaction)db.exec('ROLLBACK')}})
  f.batchHook(()=>{locked(f.path);locked(join(f.root,'evaluation.sqlite'))})
  expect(f.service.withOwnerWorkItemLearningTaskFence({...scopeInput(task),...expectation(task)},()=>{locked(f.path);locked(join(f.root,'evaluation.sqlite'));return 'terminal'})).toBe('terminal')
 })
 test('wrong item/outcome combinations cannot borrow another item owner withdrawal',async()=>{
  const f=await fixture(),a=await recorded(f,'P'),b=await recorded(f,'Q')
  await f.service.acceptInbound(f.envelope('withdraw-only-P','/feedback withdraw 1 not-achieved'));await f.settle()
  const snapshots=f.service.withOwnerLearningSourcesFence({...scopeInput(a),sources:[{...expectation(a),itemId:'Q'}, {...expectation(b),itemId:'missing-item'}]},value=>value)
  expect(snapshots[0]!.kind==='work-item'&&snapshots[0]!.task).toBeUndefined()
  expect(snapshots[0]!.kind==='work-item'&&snapshots[0]!.ownerRevision?.action).toBe('initial')
  expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.ownerRevision).toBeUndefined()
 })
 test('ordinary conflicting proof retraction does not manufacture an owner withdrawal',async()=>{
  const f=await fixture(),task=await recorded(f)
  f.reports.get('P')!.createdAt++
  await f.service.acceptInbound(f.envelope('conflicting-proof','问题解决了'));await f.settle()
  const snapshots=f.service.withOwnerLearningSourcesFence({...scopeInput(task),sources:[expectation(task)]},value=>value),snapshot=snapshots[0]!
  expect(snapshot.kind).toBe('work-item')
  if(snapshot.kind==='work-item'){expect(snapshot.currentCanonical?.projection.disposition).toBe('retract');expect(snapshot.task).toBeUndefined();expect(snapshot.ownerRevision?.action).not.toBe('withdraw')}
 })
 test('later B resolver invalidating A report hides A without blocking B',async()=>{
  const f=await fixture(),a=await recorded(f,'P'),b=await recorded(f,'Q');let hit=false
  f.batchHook(itemId=>{if(itemId==='Q'){hit=true;f.reports.delete('P')}})
  const snapshots=f.service.withOwnerLearningSourcesFence({...scopeInput(a),sources:[expectation(a),expectation(b)]},value=>value)
  expect(hit).toBe(true);expect(snapshots[0]).toMatchObject({kind:'work-item',itemId:'P'});expect(snapshots[0]!.kind==='work-item'&&snapshots[0]!.task).toBeUndefined()
  expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.task?.proofIdentity.itemId).toBe('Q')
 })
 test('later B resolver invalidating current producer hides all cached proofs',async()=>{
  const f=await fixture(),a=await recorded(f,'P'),b=await recorded(f,'Q');let hit=false
  f.batchHook(itemId=>{if(itemId==='Q'){hit=true;f.current(false)}})
  const snapshots=f.service.withOwnerLearningSourcesFence({...scopeInput(a),sources:[expectation(a),expectation(b)]},value=>value)
  expect(hit).toBe(true);expect(snapshots.every(value=>value.kind==='work-item'&&value.task===undefined)).toBe(true)
 })
 test('later B actual canonical withdrawal cannot cross the held Evaluation writer fence',async()=>{
  const f=await fixture(),a=await recorded(f,'P'),b=await recorded(f,'Q'),hostScope=f.evaluation.canonicalHostScope(scope)
  const old=f.evaluation.getTrustedOutcome({scope:hostScope,outcomeId:a.canonical.objective!.outcomeId})!,evalStore=(f.evaluation as unknown as{store:{append(input:OutcomeEnvelope,command:OwnerObjectiveCommand):StoredOutcome}}).store
  let attempted=false
  f.batchHook(itemId=>{if(itemId!=='Q')return;attempted=true
   evalStore.append({scope,situation:old.situation,executionStatus:old.executionStatus,objectiveStatus:'unknown',deliveryStatus:old.deliveryStatus,source:old.source,trust:'trusted',evidence:old.evidence,metrics:{},occurredAt:old.occurredAt+1,idempotencyKey:'batch-withdraw-A',evaluator:old.evaluator},
    {...f.owner,operationId:'batch-withdraw-A',action:'withdraw',expectedVersion:1,previousStatus:'not-achieved'})
  })
  const terminal=vi.fn()
  expect(()=>f.service.withOwnerLearningSourcesFence({...scopeInput(a),sources:[expectation(a),expectation(b)]},terminal)).toThrow(/transaction/)
  expect(attempted).toBe(true);expect(terminal).not.toHaveBeenCalled();expect(f.canonical('P')?.objective?.status).toBe('not-achieved')
  f.batchHook(undefined);expect(f.service.withOwnerWorkItemLearningTaskFence({...scopeInput(a),...expectation(a)},()=>true)).toBe(true)
 })
 test('real emergency stop from the last batch resolver blocks source use before terminal callback',async()=>{
  const f=await fixture(),task=await recorded(f);let hit=false
  f.batchHook(()=>{hit=true;f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'final batch resolve'})})
  const terminal=vi.fn()
  expect(()=>f.service.withOwnerWorkItemLearningTaskFence({...scopeInput(task),...expectation(task)},terminal)).toThrow(/unavailable or changed/)
  expect(hit).toBe(true);expect(terminal).not.toHaveBeenCalled();expect(f.ctx.assistantPolicy.getEmergencyStop().enabled).toBe(true)
 })
 test('mixed missing foreground and withdrawn work item remain distinguishable without forged inbox identities',async()=>{
  const f=await fixture(),task=await recorded(f);await f.service.acceptInbound(f.envelope('withdraw-memory','/feedback withdraw 1 not-achieved'));await f.settle()
  const snapshots=f.service.withOwnerLearningSourcesFence({...scopeInput(task),sources:[{kind:'foreground',inboxId:'not-a-real-inbox',expectedSourceDigest:'a'.repeat(64)},expectation(task)]},value=>value)
  expect(snapshots[0]).toEqual({kind:'foreground',inboxId:'not-a-real-inbox',content:undefined,currentCanonical:undefined,ownerRevision:undefined,task:undefined})
  expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.task).toBeUndefined();expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.currentCanonical?.objective?.status).toBe('unknown');expect(snapshots[1]!.kind==='work-item'&&snapshots[1]!.ownerRevision?.action).toBe('withdraw')
 })
 test('same owner new Session preserves work-item source and accepts a fresh scope watermark',async()=>{
  const f=await fixture(),task=await recorded(f);await recorded(f,'unrelated');await f.service.acceptInbound(f.envelope('memory-new-session','/new'));await f.settle()
  const current=f.learning(task.canonical.objective!.outcomeId)!;expect(current.sourceDigest).toBe(task.sourceDigest);expect(current.presentationDigest).toBe(task.presentationDigest)
  expect(f.service.withOwnerWorkItemLearningTaskFence({...scopeInput(current),...expectation(task)},value=>value.sourceDigest)).toBe(task.sourceDigest)
 })
 test('rejects repeated identities, oversize batches and accessors without invoking them',async()=>{
  const f=await fixture(),task=await recorded(f),source=expectation(task),base=scopeInput(task),callback=vi.fn()
  expect(()=>f.service.withOwnerLearningSourcesFence({...base,sources:[source,source]},callback)).toThrow(/unique/)
  expect(()=>f.service.withOwnerLearningSourcesFence({...base,sources:Array.from({length:1001},()=>source)},callback)).toThrow(/batch/)
  let reads=0;const accessor={...source};Object.defineProperty(accessor,'itemId',{enumerable:true,get:()=>{reads++;return 'P'}})
  expect(()=>f.service.withOwnerLearningSourcesFence({...base,sources:[accessor]},callback)).toThrow(/accessors/);expect(reads).toBe(0);expect(callback).not.toHaveBeenCalled()
 })
})
