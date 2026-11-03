import type { Context } from '@deepseek-ai/cordis'
import type { HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { expect, vi } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { normalizeConfig, type Config } from '../src/config.ts'
import { WorkItemContinuation } from '../src/continuation.ts'
import { CONTINUATION_OWNER, continuationDefinitionHash, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { continuationDigest, type WorkItemContinuationAdmission } from '../src/continuation-record.ts'
import { createDiagnosisPlan, diagnosisConfigurationDigest, diagnosisDefinition, diagnosisDefinitionHash, diagnosisExternalId, DIAGNOSIS_OWNER, DIAGNOSIS_TOOLS } from '../src/diagnosis-contract.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import { WorkItemOwnerReplies } from '../src/owner-replies.ts'
import type { PeerAutomationsService, PeerDeliveryService, PeerOwnerForegroundTaskSource, WorkItemReplyConsumerRegistration, WorkItemReplySource } from '../src/peers.ts'
import { isReplyContinuationPlan, parseStoredContinuationPlan } from '../src/reply-contract.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemAdmitInput, WorkItemRecord } from '../src/types.ts'
import { harness, readyItem, receipt } from './fixtures.ts'
import { WorkItemOwnerFeedbackTargets, workItemReportDigest } from '../src/feedback-targets.ts'
import { WorkItemEngineeringTargets } from '../src/engineering-context.ts'

// Component boundary: real SQLite/admission/claim/report and recorded Delivery/
// Automations peers. This file does not prove real owner/provider authentication.
export async function engineeringFixture() {
  const f=await harness(),generic=await readyItem(f)
  vi.spyOn(Date,'now').mockImplementation(f.now)
  const raw:Config={enabled:true,mode:'active',databasePath:f.config.databasePath,workRoot:f.config.workRoot,intakeSourceId:f.config.intakeSourceId,
    workerAutomationId:f.config.workerAutomationId!,scope:f.config.scope!,ownerRecall:{enabled:true},ownerReplyContinuation:true,ownerReportFeedback:true,
    admission:{...f.config.admission,maxAdmitsPerHour:100,allowedKinds:[...f.config.admission.allowedKinds,'owner-continuation']},ownerContinuation:{enabled:true,
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
  const automations={ingestExternal:()=>{throw new Error('historical engineering reads must not execute')},hostAgentAuthorizationVersion:()=>1,registerHostExecutor:()=>()=>{},runAgentForHostExecution:async()=>{throw new Error('component must not run an Agent')},
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
  let current = true
  const feedback = new WorkItemOwnerFeedbackTargets({config,store:()=>store,delivery:()=>delivery,automations:()=>automations as unknown as PeerAutomationsService,current:()=>current})
  const engineering = new WorkItemEngineeringTargets({config,store:()=>store,feedback:()=>feedback,current:()=>current})
  const feedbackCap = (id:string) => {
    const item=store.findItemById(id)!,report=store.lastReport(id)!,record=store.getContinuation(id)
    const planDigest=record?.planDigest??continuationDigest(acceptanceCanonicalJson(store.readDiagnosisPlan(id)))
    return feedback.issue({itemId:id,reportRevision:report.revision,reportDigest:workItemReportDigest(item,report,store.ownerRecallText(id,report.revision),planDigest)})
  }
  return{f,config,raw,root,generic,delivery,feedback,engineering,feedbackCap,deactivate:()=>{current=false},proofs,sources,schemas,ingested,acknowledged,scanCalls,add,child,finish,cold,
    get runtime(){return runtime!},get consumer(){return consumer!},get store(){return store},get ledger(){return ledger},get registration(){return registration!},
    setAckFault:(value:boolean)=>{ackFault=value},setCancelBeforeAck:(value:boolean)=>{cancelBeforeAck=value},setHiddenRawPrefix:()=>{hiddenRawPrefix=true},
    setHoldWake:()=>{holdWake=true},
    diagnosisParent,counts:()=>({foreground,typed}),close:()=>{engineering.close();feedback.close();consumer!.close();runtime!.close();store.close()}}
}
