import type { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import type { HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { WorkItemAuthority } from '../src/authority.ts'
import { normalizeConfig, type Config } from '../src/config.ts'
import { WorkItemContinuation } from '../src/continuation.ts'
import { CONTINUATION_OWNER, continuationConfigurationDigest, continuationDefinitionHash, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { continuationDigest, type WorkItemContinuationAdmission } from '../src/continuation-record.ts'
import { createDiagnosisPlan, diagnosisConfigurationDigest, diagnosisDefinition, diagnosisDefinitionHash, diagnosisExternalId, DIAGNOSIS_OWNER, DIAGNOSIS_TOOLS } from '../src/diagnosis-contract.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import { WorkItemOwnerReplies } from '../src/owner-replies.ts'
import type { PeerDeliveryService, PeerOwnerForegroundTaskSource, WorkItemReplyConsumerRegistration, WorkItemReplySource } from '../src/peers.ts'
import { isReplyContinuationPlan, parseStoredContinuationPlan } from '../src/reply-contract.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemAdmitInput, WorkItemRecord } from '../src/types.ts'
import { harness, readyItem, receipt } from './fixtures.ts'

// Component boundary: real SQLite/admission/claim/report and recorded Delivery/
// Automations peers. This file does not prove real owner/provider authentication.
afterEach(()=>vi.restoreAllMocks())
async function fixture() {
  const f=await harness(),generic=await readyItem(f)
  vi.spyOn(Date,'now').mockImplementation(f.now)
  const raw:Config={enabled:true,mode:'active',databasePath:f.config.databasePath,workRoot:f.config.workRoot,intakeSourceId:f.config.intakeSourceId,
    workerAutomationId:f.config.workerAutomationId!,scope:f.config.scope!,ownerRecall:{enabled:true},ownerReplyContinuation:true,
    admission:{...f.config.admission,allowedKinds:[...f.config.admission.allowedKinds,'owner-continuation']},ownerContinuation:{enabled:true,
      automationId:'continuation-worker',allowedTools:['work_item_claim','work_item_report','work_item_read_context','marker'],budgetId:'continuations',budgetAmount:1,
      maxModelCalls:8,maxToolCalls:20,maxOutputTokens:256,timeoutMs:15000,expiresAt:f.now()+3600000}}
  const config=normalizeConfig(raw,f.now()),owner=receipt({authorityId:config.scope!.ownerRouteId,principalId:config.scope!.principalId,
    workspace:config.scope!.workspace,agentPreset:config.scope!.preset})
  let store=f.store,ledger=f.ledger,definition:HostAutomationDefinition|undefined,registration:WorkItemReplyConsumerRegistration|undefined
  let runtime:WorkItemContinuation,consumer:WorkItemOwnerReplies,privateAdmission:WorkItemAdmission
  const proofs=new Map<string,ContinuationProductionProof>(),sources=new Map<string,WorkItemReplySource>(),heads=new Map<string,string>()
  const mints=new WeakMap<WorkItemAdmitInput,WorkItemContinuationAdmission>(),ingested:string[]=[],acknowledged:string[]=[],scanCalls:number[]=[]
  let ackFault=false,cancelBeforeAck=false,hiddenRawPrefix=false,holdWake=false,foreground=0,typed=0
  const currentSource=(id:string,digest:string)=>{
    const source=sources.get(id)
    if(!source || source.sourceDigest!==digest) throw new Error('reply missing')
    if(source.state==='cancelled') throw Object.assign(new Error('durable cancelled'),{code:'work-item-reply-cancelled'})
    return structuredClone(source)
  }
  const delivery:PeerDeliveryService={validateOwnerRoute:()=>owner,
    workItemReplyProtocolVersion:()=>1,registerWorkItemReplyConsumer:input=>{registration=input;return()=>{if(registration===input)registration=undefined}},
    enqueueBackground:()=>{foreground++;return{id:'ordinary-outbox'}},
    enqueueWorkItemReport:input=>{
      const target=registration?.inspectReport({...input,format:input.format??'plain'})
      if(!target) throw new Error('untrusted report')
      typed++;return{id:'typed-outbox'}
    },listPendingWorkItemReplies:input=>{
      scanCalls.push(input.afterSequence??0)
      if(hiddenRawPrefix && (input.afterSequence??0)===0) return{items:[],hasMore:true,nextAfterSequence:100}
      const oldest=new Map<string,WorkItemReplySource>()
      for(const source of sources.values()) if(source.state==='pending' && !oldest.has(source.target.streamId)) oldest.set(source.target.streamId,source)
      const rows=[...oldest.values()].filter(row=>row.admissionCursor.sequence>(input.afterSequence??0)).sort((a,b)=>a.admissionCursor.sequence-b.admissionCursor.sequence)
      return{items:rows.slice(0,input.limit).map(row=>structuredClone(row)),hasMore:rows.length>input.limit,
        nextAfterSequence:rows.length>input.limit?rows[input.limit-1]!.admissionCursor.sequence:null}
    },readWorkItemReply:input=>currentSource(input.id,input.expectedSourceDigest),
    selectWorkItemReplyParent:input=>{
      const source=currentSource(input.id,input.expectedSourceDigest)
      if(!source.executionParentItemId) sources.set(source.id,{...source,executionParentItemId:heads.get(source.target.streamId)??source.target.streamId})
      return currentSource(input.id,input.expectedSourceDigest)
    },acknowledgeWorkItemReply:input=>{
      const source=currentSource(input.id,input.expectedSourceDigest)
      if(cancelBeforeAck) {sources.set(source.id,{...source,state:'cancelled'});throw Object.assign(new Error('durable cancelled'),{code:'work-item-reply-cancelled'})}
      if(ackFault) throw new Error('test crash after real child admission')
      if(!registration?.inspectChild({replyId:source.id,sourceDigest:source.sourceDigest,parentItemId:source.executionParentItemId!,
        childItemId:input.childItemId,childPlanDigest:input.childPlanDigest})) throw new Error('untrusted child')
      const routed={...source,state:'routed' as const,child:{itemId:input.childItemId,planDigest:input.childPlanDigest}}
      sources.set(source.id,routed);heads.set(source.target.streamId,input.childItemId);acknowledged.push(input.childItemId)
      return structuredClone(routed)
    }}
  const schemas=config.ownerContinuation!.allowedTools.map(name=>({name,description:name,parameters:{type:'object',additionalProperties:false}}))
  const automations={hostAgentAuthorizationVersion:()=>1,registerHostExecutor:()=>()=>{},runAgentForHostExecution:async()=>{throw new Error('component must not run an Agent')},
    reconcileSystem:(input:{definition:HostAutomationDefinition})=>{definition=input.definition},inspectSystemOwned:()=>{
      if(!definition) throw Object.assign(new Error('not found'),{code:'not-found'})
      return{owner:CONTINUATION_OWNER,automationId:'continuation-worker',automationStatus:'active',definitionHash:continuationDefinitionHash(definition),definitionVersion:1}
    },inspectSystemOwnedActivation:()=>({definitionHash:continuationDefinitionHash(definition!),activationNonce:definition!.execution.activationNonce,ownerRouteId:config.scope!.ownerRouteId}),
    inspectProductionOccurrence:(input:{occurrenceId:string})=>proofs.get(input.occurrenceId)}
  const context={get:(name:string)=>({assistantAutomations:automations,assistantDelivery:delivery,assistantPolicy:f.policy.service})[name as 'assistantAutomations'],tools:{schemas:()=>schemas}} as unknown as Context
  const proof=(item:WorkItemRecord,occurrenceId:string):ContinuationProductionProof=>({protocol:'assistant-automations/production-occurrence/v1',
    automationId:item.workerAutomationId,occurrenceId,taskId:`task-${occurrenceId}`,attemptId:`attempt-${occurrenceId}`,runId:`run-${occurrenceId}`,
    executionMode:'production',status:'succeeded',completedAt:f.now(),quiescent:true,budgetSettlementState:item.workerAutomationId==='continuation-worker'?'finalized':'not-required',
    immutableContext:{state:'verified',definitionHash:item.workerAutomationId==='continuation-worker'?continuationDefinitionHash(definition!):'a'.repeat(64),definitionVersion:1,
      scope:{workspace:item.scope.workspace,agentPreset:item.scope.preset},...(item.workerAutomationId==='continuation-worker'?{owner:CONTINUATION_OWNER}:{})}})
  proofs.set(`occ-${generic.id}`,proof(generic,`occ-${generic.id}`))
  const mint=(input:WorkItemAdmitInput,builder:WorkItemContinuationAdmission)=>{
    mints.set(input,builder);try{return privateAdmission.admit(input)}finally{mints.delete(input)}
  }
  const mount=()=>{
    const {diagnosis:_diagnosis,...shared}=config
    privateAdmission=new WorkItemAdmission({config:{...shared,workerAutomationId:'continuation-worker',limits:{...config.limits,maxAttempts:1}},
      store,ledger,workspace:f.ledger.workspace,policy:f.policy.service,delivery,now:f.now,continuationFor:input=>mints.get(input)})
    runtime=new WorkItemContinuation(context,config,store,{assertOwner:item=>{
      if(item.owner.principalRecordId!==owner.principalRecordId || item.owner.principalVersion!==owner.principalVersion
        || item.owner.generation!==owner.generation || item.owner.bindingVersion!==owner.bindingVersion) throw new Error('owner differs')
      return owner
    },assertMandate:()=>{if(f.policy.decision.effect!=='allow') throw new Error('mandate denied')},isReplyConsumerCurrent:()=>consumer?.isCurrent()===true,wake:item=>{
      if(holdWake)return false
      if(!runtime.validateWake(item)) return false
      const record=store.getContinuation(item.id)!,plan=parseStoredContinuationPlan(record.planJson)
      if(isReplyContinuationPlan(plan)) expect(acknowledged).toContain(item.id)
      ingested.push(item.id);store.markDispatchDispatched(item.id,`reply-occ-${item.id}`);return true
    }})
    runtime.start()
    const dispatch=new WorkItemDispatch({config,store,ledger,delivery,automations:undefined})
    consumer=new WorkItemOwnerReplies({config,store,delivery:()=>delivery,runtime:()=>runtime,admit:mint,
      notification:(item,report)=>dispatch.notification(item,report),retire:ids=>{
        for(const id of ids){const item=store.findItemById(id);if(item)store.withdrawByDedupKey(item.dedupKey)}runtime.retire(ids)
      }})
    consumer.start()
  }
  mount()
  const manual=runtime!.prepare(generic.id,{sourceDigest:'b'.repeat(64),inputText:'original authenticated request',modelSelection:{provider:'original-provider',model:'original-model'}},()=>{})
  const root=mint({kind:'owner-continuation',externalId:manual.sourceKey,title:'Manual root',brief:'Use old report',originBindingId:generic.originBindingId},manual).item
  store.markDispatchDispatched(root.id,`reply-occ-${root.id}`)
  ledger.claim({itemId:root.id,runId:`reply-occ-${root.id}`,occurrenceId:`reply-occ-${root.id}`})
  ledger.report({itemId:root.id,runId:`reply-occ-${root.id}`,status:'ready',summary:'Root result 😀',artifactPaths:[],idempotencyKey:'root-ready'})
  proofs.set(`reply-occ-${root.id}`,proof(root,`reply-occ-${root.id}`))
  const add=(id:string,text:string,sequence=sources.size+1,targetItemId=root.id)=>{
    const targetItem=store.findItemById(targetItemId)!,report=store.lastReport(targetItemId)!,reportDispatch=new WorkItemDispatch({config,store,ledger,delivery,automations:undefined})
    const notification=reportDispatch.notification(targetItem,report)
    const target=registration!.inspectReport({itemId:targetItemId,reportRevision:report.revision,bindingId:targetItem.originBindingId,
      idempotencyKey:report.deliveryKey,text:notification.text,format:'markdown'})
    const targetInfo=target??{streamId:targetItemId,reportDigest:'d'.repeat(64)}
    const source:WorkItemReplySource={protocol:'assistant-delivery/work-item-reply/v1',id,sourceDigest:acceptanceDigest({id,text,targetItemId}),
      admissionCursor:{epoch:'fixture-epoch',sequence},inputText:text,inputSha256:continuationDigest(text),inputBytes:Buffer.byteLength(text),
      scope:{workspace:config.scope!.workspace,preset:config.scope!.preset},principalId:config.scope!.principalId,
      owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},binding:{id:root.originBindingId,version:owner.bindingVersion,generation:owner.generation},
      target:{outboxId:`outbox-${targetItemId}`,providerMessageId:`provider-${targetItemId}`,itemId:targetItemId,reportRevision:report.revision,
        reportDigest:targetInfo.reportDigest,streamId:targetInfo.streamId},state:'pending'}
    sources.set(id,source);return source
  }
  const child=(replyId:string)=>{const source=sources.get(replyId);return source?.child?store.findItemById(source.child.itemId):undefined}
  const finish=(item:WorkItemRecord,quiet=true)=>{
    const occurrence=store.getDispatch(item.id)!.occurrenceId!
    ledger.claim({itemId:item.id,runId:occurrence,occurrenceId:occurrence})
    ledger.report({itemId:item.id,runId:occurrence,status:'ready',summary:`Result ${item.id}`,artifactPaths:[],idempotencyKey:`ready-${item.id}`})
    if(quiet)proofs.set(occurrence,proof(item,occurrence))
  }
  const cold=()=>{
    consumer!.close();runtime!.close();store.close()
    store=new WorkItemStore(config.databasePath,{now:f.now})
    ledger=new WorkItemLedger({store,workspace:f.ledger.workspace,limits:config.limits,now:f.now})
    mount()
  }
  const diagnosisParent=()=>{
    const diagnosisConfig=normalizeConfig({...raw,sources:{foregroundFailures:{enabled:true,kind:'review'}},diagnosis:{enabled:true,
      budgetId:'diagnosis-runs',budgetAmount:1,maxModelCalls:4,maxToolCalls:6,maxOutputTokens:256,timeoutMs:15000,expiresAt:f.now()+3600000}},f.now())
    const original:PeerOwnerForegroundTaskSource={protocol:'assistant-delivery/owner-foreground-source/v1',inboxId:'original-inbox',sourceDigest:'9'.repeat(64),
      completionSequence:1,authorityId:owner.authorityId,authorityHash:owner.authorityHash,principalId:owner.principalId,
      scope:{workspace:owner.workspace,preset:owner.agentPreset},binding:{id:generic.originBindingId,version:owner.bindingVersion,generation:owner.generation,sessionId:'original-session'},
      owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},
      execution:{dispatchedAt:f.now()-10,completedAt:f.now()-1,executionRef:'original-inbox',status:'unknown',quiescent:false,
        modelSelectionState:'frozen',modelSelection:{provider:'diagnostic-provider',model:'diagnostic-model',reasoningEffort:'low'}},
      termination:{protocol:'assistant-delivery/foreground-termination/v1',producer:'delivery-agent',kind:'error',causeCode:'turn-error',handleDisposed:true,effects:'unknown',replay:'forbidden'}}
    const schemas=DIAGNOSIS_TOOLS.map(name=>({name,description:name,parameters:{type:'object',additionalProperties:false}}))
    const activation={protocol:'assistant-work-items/diagnosis-activation/v1' as const,stage:'established' as const,
      configurationDigest:diagnosisConfigurationDigest(diagnosisConfig,schemas),activationNonce:'2'.repeat(64),reconciliationKey:'diagnosis-activation',
      definitionHash:diagnosisDefinitionHash(diagnosisDefinition(diagnosisConfig,'2'.repeat(64),'3'.repeat(64))),definitionVersion:1,catalogDigest:'3'.repeat(64),ownerReceipt:owner}
    const item:WorkItemRecord={...store.findItemById(generic.id)!,id:'diagnosis-parent',dedupKey:'diagnosis-parent-key',sourceId:diagnosisConfig.intakeSourceId,
      kind:'review',externalId:diagnosisExternalId(original),state:'queued',stateReason:null,attempt:0,lastReportStatus:null,leaseUntil:null,leaseRunId:null,occurrenceId:null,
      originBindingId:generic.originBindingId,workDir:f.ledger.workspace.directoryFor('diagnosis-parent'),createdAt:f.now(),updatedAt:f.now()}
    const plan=createDiagnosisPlan(item,original,diagnosisConfig,activation,schemas)
    store.admitItem(item,{kind:'admitted',actor:'admission',detail:{kind:item.kind,dedupBucket:item.dedupBucket,provenance:null}},
      {itemId:item.id,automationId:item.workerAutomationId,eventId:item.id,occurredAt:item.createdAt,generation:0,wakeAttempts:0,state:'pending',occurrenceId:null,reason:null,createdAt:item.createdAt,updatedAt:item.createdAt},[],plan)
    const occurrence='diagnosis-occurrence'
    store.markDispatchDispatched(item.id,occurrence)
    ledger.claim({itemId:item.id,runId:occurrence,occurrenceId:occurrence})
    ledger.report({itemId:item.id,runId:occurrence,status:'ready',summary:'Diagnosis result',artifactPaths:[],idempotencyKey:'diagnosis-ready'})
    const production:ContinuationProductionProof={...proof(item,occurrence),budgetSettlementState:'finalized',
      immutableContext:{state:'verified',definitionHash:activation.definitionHash,definitionVersion:1,owner:DIAGNOSIS_OWNER,scope:{workspace:item.scope.workspace,agentPreset:item.scope.preset}}}
    proofs.set(occurrence,production)
    return{item,plan,production,occurrence}
  }
  return{f,config,raw,root,generic,delivery,proofs,sources,schemas,ingested,acknowledged,scanCalls,add,child,finish,cold,
    get runtime(){return runtime!},get consumer(){return consumer!},get store(){return store},get ledger(){return ledger},get registration(){return registration!},
    setAckFault:(value:boolean)=>{ackFault=value},setCancelBeforeAck:(value:boolean)=>{cancelBeforeAck=value},setHiddenRawPrefix:()=>{hiddenRawPrefix=true},
    setHoldWake:()=>{holdWake=true},
    diagnosisParent,counts:()=>({foreground,typed}),close:()=>{consumer!.close();runtime!.close();store.close()}}
}

test('the independent root opt-in preserves existing continuation and diagnosis activation digests',async()=>{
  const f=await fixture()
  try {
    const off=normalizeConfig({...f.raw,ownerReplyContinuation:false},f.f.now())
    expect(continuationConfigurationDigest(off,f.schemas)).toBe(continuationConfigurationDigest(f.config,f.schemas))
    const diagnosisSchemas=DIAGNOSIS_TOOLS.map(name=>({name}))
    expect(diagnosisConfigurationDigest(off,diagnosisSchemas)).toBe(diagnosisConfigurationDigest(f.config,diagnosisSchemas))
    expect(()=>normalizeConfig({...f.raw,ownerReplyContinuation:true,ownerContinuation:{enabled:false}},f.f.now())).toThrow(/requires active ownerContinuation/u)
    const before=f.store.getContinuation(f.root.id)!.planJson
    f.cold();expect(f.store.getContinuation(f.root.id)!.planJson).toBe(before)
    expect(parseStoredContinuationPlan(before).protocol).toBe('assistant-work-items/owner-continuation-plan/v1')
  }finally{f.close()}
})

test('typed report selection retains ordinary reports and the digest ignores later delivery bookkeeping',async()=>{
  const f=await fixture()
  try {
    const dispatch=new WorkItemDispatch({config:f.config,store:f.store,ledger:f.ledger,delivery:f.delivery,automations:undefined,
      replyReportEligible:(item,report,notification)=>f.consumer.canEnqueue(item,report,notification)})
    const item=f.store.findItemById(f.root.id)!,report=f.store.lastReport(item.id)!,notification=dispatch.notification(item,report)
    const input={itemId:item.id,reportRevision:report.revision,bindingId:item.originBindingId,idempotencyKey:report.deliveryKey,text:notification.text,format:'markdown' as const}
    const before=f.registration.inspectReport(input)
    expect(before).toBeDefined();await dispatch.notify(item,report)
    expect(f.registration.inspectReport(input)).toEqual(before)
    await dispatch.notify(f.store.findItemById(f.generic.id)!,f.store.lastReport(f.generic.id)!)
    expect(f.counts()).toEqual({foreground:1,typed:1})
    expect(f.registration.inspectReport({...input,text:'forged metadata/body'})).toBeUndefined()
    expect(f.registration.inspectReport({...input,bindingId:'foreign-binding'})).toBeUndefined()
  }finally{f.close()}
})

test('each reply is ACKed before wake and the next selected parent waits for exact outer quiescence',async()=>{
  const f=await fixture()
  try {
    f.add('reply-1','first');f.add('reply-2','second')
    f.consumer.drain()
    const first=f.child('reply-1')!
    expect(first).toBeDefined();expect(f.child('reply-2')).toBeUndefined();expect(f.ingested).toEqual([first.id])
    f.consumer.drain();expect(f.sources.get('reply-2')?.executionParentItemId).toBe(first.id);expect(f.child('reply-2')).toBeUndefined()
    f.finish(first,false);f.consumer.drain();expect(f.child('reply-2')).toBeUndefined()
    const occurrence=f.store.getDispatch(first.id)!.occurrenceId!
    const plan=parseStoredContinuationPlan(f.store.getContinuation(first.id)!.planJson)
    f.proofs.set(occurrence,{...plan.parent.production,automationId:'continuation-worker',occurrenceId:occurrence,
      taskId:'next-task',attemptId:'next-attempt',runId:'next-run',budgetSettlementState:'finalized',
      immutableContext:{state:'verified',definitionHash:plan.activation.definitionHash,definitionVersion:1,owner:CONTINUATION_OWNER,
        scope:{workspace:first.scope.workspace,agentPreset:first.scope.preset}}})
    f.consumer.drain();const second=f.child('reply-2')!
    const secondPlan=parseStoredContinuationPlan(f.store.getContinuation(second.id)!.planJson)
    expect(isReplyContinuationPlan(secondPlan)).toBe(true)
    if(!isReplyContinuationPlan(secondPlan))throw new Error('expected v2')
    expect(secondPlan.parent.itemId).toBe(first.id);expect(secondPlan.source.origin.reply.target.itemId).toBe(f.root.id)
    expect(secondPlan.authorization.modelOrigin).toBe('inherited-parent-execution')
    expect(secondPlan.contract).toMatchObject({provider:'original-provider',model:'original-model'})
    expect(secondPlan.contract).not.toHaveProperty('reasoningEffort')
    expect(f.sources.get('reply-1')?.inputText).toBe('first')
  }finally{f.close()}
})

test('real admission before a failed ACK survives cold WorkItems SQLite reopening without a second child or early wake',async()=>{
  const f=await fixture()
  try {
    f.add('reply-1','continue');f.setAckFault(true);f.consumer.drain()
    const rows=f.store.listPendingContinuations('continuation-worker')
    expect(rows).toHaveLength(1);expect(f.ingested).toEqual([]);expect(f.child('reply-1')).toBeUndefined()
    const before=rows[0]!.continuation
    f.setAckFault(false);f.cold()
    expect(f.child('reply-1')?.id).toBe(before.itemId);expect(f.ingested).toEqual([before.itemId])
    expect(f.store.getContinuation(before.itemId)).toEqual(before)
    f.consumer.drain();expect(f.ingested).toEqual([before.itemId])
  }finally{f.close()}
})

test('cancelled after admission and before ACK retires the orphan on cold recovery and frees open capacity',async()=>{
  const f=await fixture()
  try {
    f.add('reply-1','cancel me');f.setCancelBeforeAck(true);f.consumer.drain()
    expect(f.sources.get('reply-1')?.state).toBe('cancelled');expect(f.ingested).toEqual([])
    f.cold()
    const record=f.store.listItems({limit:20}).find(item=>item.id!==f.root.id&&item.id!==f.generic.id)!
    expect(record.state).toBe('dropped');expect(f.store.countOpenItems()).toBe(0)
    expect(f.child('reply-1')).toBeUndefined();expect(f.store.getDispatch(record.id)?.state).toBe('failed')
  }finally{f.close()}
})

test('raw scan progress is retained even if a complete page has no eligible replies',async()=>{
  const f=await fixture()
  try {
    f.setHiddenRawPrefix();f.add('reply-after-stale-prefix','continue',101)
    f.consumer.drain();expect(f.child('reply-after-stale-prefix')).toBeUndefined()
    expect(f.store.meta('reply-continuation.scan/v1')).toBe('{"sequence":100}')
    f.consumer.drain();expect(f.child('reply-after-stale-prefix')).toBeDefined()
    expect(f.scanCalls.slice(-2)).toEqual([0,100])
  }finally{f.close()}
})

test('planless generic parents cannot mint a v2 source and do not dispatch',async()=>{
  const f=await fixture()
  try {
    f.add('reply-generic','continue',1,f.generic.id);f.consumer.drain()
    expect(f.child('reply-generic')).toBeUndefined();expect(f.ingested).toEqual([])
    expect(f.sources.get('reply-generic')?.state).toBe('pending')
  }finally{f.close()}
})

test('policy loss is retained as pending rather than misclassified as durable cancellation',async()=>{
  const f=await fixture()
  try {
    f.add('reply-1','continue');f.setAckFault(true);f.consumer.drain()
    const pending=f.store.listPendingContinuations('continuation-worker')[0]!
    const original=f.delivery.readWorkItemReply!
    f.delivery.readWorkItemReply=()=>{throw new Error('temporary policy denial')}
    f.runtime.wakePending();expect(f.store.findItemById(pending.item.id)?.state).toBe('queued')
    expect(f.store.getDispatch(pending.item.id)?.state).toBe('pending')
    f.delivery.readWorkItemReply=original
    f.setAckFault(false);f.consumer.drain();expect(f.child('reply-1')?.id).toBe(pending.item.id)
  }finally{f.close()}
})

test('diagnosis supplier inheritance requires its exact producer hash, version and owner',async()=>{
  const f=await fixture()
  try {
    const parent=f.diagnosisParent();f.add('diagnosis-reply','按诊断继续\0😀',1,parent.item.id)
    for(const immutableContext of [{...parent.production.immutableContext,definitionHash:'f'.repeat(64)},
      {...parent.production.immutableContext,definitionVersion:2},{...parent.production.immutableContext,owner:'foreign-producer'}]) {
      f.proofs.set(parent.occurrence,{...parent.production,immutableContext});f.consumer.drain()
      expect(f.child('diagnosis-reply')).toBeUndefined();expect(f.ingested).toEqual([])
    }
    f.proofs.set(parent.occurrence,parent.production);f.consumer.drain()
    const child=f.child('diagnosis-reply')!,record=f.store.getContinuation(child.id)!,plan=parseStoredContinuationPlan(record.planJson)
    expect(isReplyContinuationPlan(plan)).toBe(true)
    if(!isReplyContinuationPlan(plan))throw new Error('expected v2')
    expect(plan.contract).toMatchObject({provider:'diagnostic-provider',model:'diagnostic-model',reasoningEffort:'low'})
    expect(plan.source.origin.supplier).toMatchObject({kind:'diagnosis-plan',itemId:parent.item.id,planDigest:continuationDigest(acceptanceCanonicalJson(parent.plan))})
    expect(record.inputText).toBe('按诊断继续\0😀')
  }finally{f.close()}
})

test('only the live owned registration and the exact sealed child association are accepted',async()=>{
  const f=await fixture()
  try {
    expect(f.consumer.owns(f.registration)).toBe(true);expect(f.consumer.owns({...f.registration})).toBe(false)
    f.add('reply-1','continue');f.setAckFault(true);f.consumer.drain()
    const record=f.store.listPendingContinuations('continuation-worker')[0]!.continuation
    const input={replyId:'reply-1',sourceDigest:record.sourceDigest,parentItemId:record.parentItemId,childItemId:record.itemId,childPlanDigest:record.planDigest}
    expect(f.registration.inspectChild(input)).toBe(true)
    for(const wrong of [{replyId:'other-reply'},{parentItemId:'other-parent'},{childPlanDigest:'e'.repeat(64)},{sourceDigest:'e'.repeat(64)}]) {
      expect(f.registration.inspectChild({...input,...wrong})).toBe(false)
    }
    const registration=f.registration;f.consumer.close()
    expect(f.consumer.owns(registration)).toBe(false);expect(registration.inspectChild(input)).toBe(false)
  }finally{f.close()}
})

test('expired continuation authority declines typed eligibility while retaining ordinary report delivery',async()=>{
  const f=await fixture()
  try {
    const dispatch=new WorkItemDispatch({config:f.config,store:f.store,ledger:f.ledger,delivery:f.delivery,automations:undefined,
      replyReportEligible:(item,report,notification)=>f.consumer.canEnqueue(item,report,notification)})
    f.f.advance(3600001)
    await dispatch.notify(f.store.findItemById(f.root.id)!,f.store.lastReport(f.root.id)!)
    expect(f.counts()).toEqual({foreground:1,typed:0})
  }finally{f.close()}
})

test('cancellation inside a Policy callback cannot leak an external occurrence after the initial wake check',async()=>{
  const f=await fixture()
  try {
    f.setHoldWake();f.add('reply-1','continue');f.consumer.drain()
    const item=f.child('reply-1')!
    expect(f.store.getDispatch(item.id)?.state).toBe('pending')
    const original=f.f.policy.service.authorize
    f.f.policy.service.authorize=(request,options)=>{
      const decision=original(request,options)
      const source=f.sources.get('reply-1')!
      f.sources.set(source.id,{...source,state:'cancelled'});f.registration.onCancelled([item.id])
      return decision
    }
    const ingest=vi.fn(()=>({id:'must-not-exist',automationId:'continuation-worker'}))
    const {diagnosis:_diagnosis,...shared}=f.config
    const dispatch=new WorkItemDispatch({config:{...shared,workerAutomationId:'continuation-worker'},store:f.store,ledger:f.ledger,delivery:f.delivery,
      automations:{ingestExternal:ingest},authority:new WorkItemAuthority({policy:()=>f.f.policy.service}),validateWake:record=>f.runtime.validateWake(record)})
    expect(dispatch.wake(item)).toBe(false);expect(ingest).not.toHaveBeenCalled()
    expect(f.store.findItemById(item.id)?.state).toBe('dropped')
  }finally{f.close()}
})

test('a registration returned after synchronous consumer disposal is immediately removed',async()=>{
  const f=await fixture()
  let consumer:WorkItemOwnerReplies|undefined
  try {
    const removed=vi.fn(),delivery={...f.delivery,registerWorkItemReplyConsumer:()=>{consumer!.close();return removed}}
    const dispatch=new WorkItemDispatch({config:f.config,store:f.store,ledger:f.ledger,delivery,automations:undefined})
    consumer=new WorkItemOwnerReplies({config:f.config,store:f.store,delivery:()=>delivery,runtime:()=>f.runtime,
      admit:()=>{throw new Error('disposed consumer must not admit')},notification:(item,report)=>dispatch.notification(item,report),retire:()=>{}})
    consumer.start();expect(removed).toHaveBeenCalledTimes(1);expect(consumer.health().registered).toBe(false)
  }finally{consumer?.close();f.close()}
})

test('cancellation inside the final wake callback is checked again before external ingestion',async()=>{
  const f=await fixture()
  try {
    f.setHoldWake();f.add('reply-1','continue');f.consumer.drain();const item=f.child('reply-1')!
    let calls=0
    const ingest=vi.fn(()=>({id:'must-not-exist',automationId:'continuation-worker'}))
    const dispatch=new WorkItemDispatch({config:{...f.config,workerAutomationId:'continuation-worker'},store:f.store,ledger:f.ledger,delivery:f.delivery,
      automations:{ingestExternal:ingest},validateWake:record=>{
        const valid=f.runtime.validateWake(record)
        if(++calls===2) {
          const source=f.sources.get('reply-1')!;f.sources.set(source.id,{...source,state:'cancelled'});f.registration.onCancelled([item.id])
        }
        return valid
      }})
    expect(dispatch.wake(item)).toBe(false);expect(calls).toBe(2);expect(ingest).not.toHaveBeenCalled()
  }finally{f.close()}
})

test('consumer disposal inside the final wake callback is fenced even if durable rows did not change',async()=>{
  const f=await fixture()
  try {
    f.setHoldWake();f.add('reply-1','continue');f.consumer.drain();const item=f.child('reply-1')!
    let calls=0
    const ingest=vi.fn(()=>({id:'must-not-exist',automationId:'continuation-worker'}))
    const dispatch=new WorkItemDispatch({config:{...f.config,workerAutomationId:'continuation-worker'},store:f.store,ledger:f.ledger,delivery:f.delivery,
      automations:{ingestExternal:ingest},validateWake:record=>{
        const valid=f.runtime.validateWake(record);if(++calls===2)f.consumer.close();return valid
      },validateWakeLocal:()=>f.consumer.health().registered})
    expect(dispatch.wake(item)).toBe(false);expect(calls).toBe(2);expect(ingest).not.toHaveBeenCalled()
    expect(f.store.findItemById(item.id)?.state).toBe('queued');expect(f.store.getDispatch(item.id)?.state).toBe('pending')
  }finally{f.close()}
})

test('a hidden NUL suffix written during the final callback cannot change the dispatch identity',async()=>{
  const f=await fixture()
  try {
    f.setHoldWake();f.add('reply-1','continue');f.consumer.drain();const item=f.child('reply-1')!
    let calls=0
    const ingest=vi.fn(()=>({id:'must-not-exist',automationId:'continuation-worker'}))
    const dispatch=new WorkItemDispatch({config:{...f.config,workerAutomationId:'continuation-worker'},store:f.store,ledger:f.ledger,delivery:f.delivery,
      automations:{ingestExternal:ingest},validateWake:record=>{
        const valid=f.runtime.validateWake(record)
        if(++calls===2) {
          const before=f.store.getDispatch(item.id)!,db=new DatabaseSync(f.config.databasePath)
          try{db.prepare('UPDATE work_item_dispatch SET event_id=? WHERE item_id=?').run(before.eventId+'\0tail',item.id)}finally{db.close()}
        }
        return valid
      },validateWakeLocal:record=>f.runtime.isWakeCurrent(record)})
    expect(dispatch.wake(item)).toBe(false);expect(ingest).not.toHaveBeenCalled()
  }finally{f.close()}
})

test('expiry during the final callback is rejected by the pure local deadline fence',async()=>{
  const f=await fixture()
  try {
    f.setHoldWake();f.add('reply-1','continue');f.consumer.drain();const item=f.child('reply-1')!
    let calls=0
    const ingest=vi.fn(()=>({id:'must-not-exist',automationId:'continuation-worker'}))
    const dispatch=new WorkItemDispatch({config:{...f.config,workerAutomationId:'continuation-worker'},store:f.store,ledger:f.ledger,delivery:f.delivery,
      automations:{ingestExternal:ingest},validateWake:record=>{
        const valid=f.runtime.validateWake(record);if(++calls===2)f.f.advance(3600001);return valid
      },validateWakeLocal:record=>f.runtime.isWakeCurrent(record)})
    expect(dispatch.wake(item)).toBe(false);expect(ingest).not.toHaveBeenCalled()
    expect(f.store.getDispatch(item.id)?.state).toBe('pending')
  }finally{f.close()}
})
