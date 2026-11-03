import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { normalizeConfig, type Config } from '../src/config.ts'
import { CONTINUATION_OWNER, CONTINUATION_PROMPT_VERSION, continuationCanonical, continuationConfigurationDigest, continuationDefinition,
  continuationDefinitionHash, continuationOwnerLineage, createContinuationPlan, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { continuationDigest, continuationSourceKey } from '../src/continuation-record.ts'
import { createDiagnosisPlan, diagnosisConfigurationDigest, diagnosisDefinition, diagnosisDefinitionHash, diagnosisExternalId, DIAGNOSIS_OWNER, DIAGNOSIS_TOOLS } from '../src/diagnosis-contract.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemOwnerFeedbackTargets, workItemReportDigest } from '../src/feedback-targets.ts'
import { WorkItemOwnerReplies } from '../src/owner-replies.ts'
import type { WorkItemContinuation } from '../src/continuation.ts'
import type { PeerAutomationsService, PeerDeliveryService, PeerOwnerForegroundTaskSource, WorkItemReplyConsumerRegistration } from '../src/peers.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import type { WorkItemRecord } from '../src/types.ts'
import { admitted, harness, readyItem, receipt } from './fixtures.ts'

// Real SQLite/ledger/Cordis components, with recorded owner and production
// proof peers. Native provider/transport behavior is a separate integration.
afterEach(()=>vi.restoreAllMocks())
async function fixture(overrides:Partial<Config>={}) {
  const base=await harness(),parent=await readyItem(base)
  vi.spyOn(Date,'now').mockImplementation(base.now)
  const raw:Config={enabled:true,mode:'active',databasePath:base.config.databasePath,workRoot:base.config.workRoot,
    intakeSourceId:base.config.intakeSourceId,workerAutomationId:base.config.workerAutomationId!,scope:base.config.scope!,ownerRecall:{enabled:true},ownerReportFeedback:true,
    admission:{...base.config.admission,allowedKinds:[...base.config.admission.allowedKinds,'owner-continuation']},
    ownerContinuation:{enabled:true,automationId:'continuation-worker',allowedTools:['work_item_claim','work_item_report','work_item_read_context'],
      budgetId:'continuations',budgetAmount:1,maxModelCalls:4,maxToolCalls:6,maxOutputTokens:256,timeoutMs:15000,expiresAt:base.now()+3600000},...overrides}
  const config=normalizeConfig(raw,base.now())
  let owner=receipt({authorityId:config.scope!.ownerRouteId,principalId:config.scope!.principalId,workspace:config.scope!.workspace,agentPreset:config.scope!.preset})
  const schemas=config.ownerContinuation!.allowedTools.map(name=>({name,description:name,parameters:{type:'object',additionalProperties:false}}))
  const catalogDigest=acceptanceDigest({protocol:CONTINUATION_PROMPT_VERSION,schemas}),nonce='c'.repeat(64)
  const activation={protocol:'assistant-work-items/continuation-activation/v1' as const,stage:'established' as const,
    configurationDigest:continuationConfigurationDigest(config,schemas),activationNonce:nonce,reconciliationKey:'old-established-activation',
    definitionHash:continuationDefinitionHash(continuationDefinition(config,nonce,catalogDigest)),definitionVersion:1,catalogDigest,ownerLineage:continuationOwnerLineage(owner)}
  const item:WorkItemRecord={...base.store.findItemById(parent.id)!,id:'feedback-item',dedupKey:'feedback-item-key',externalId:'feedback-item-source',title:'Feedback task',
    brief:'original task\0full-tail 😀',workerAutomationId:'continuation-worker',scope:config.scope!,state:'queued',stateReason:null,attempt:0,maxAttempts:1,
    lastReportStatus:null,leaseUntil:null,leaseRunId:null,occurrenceId:null,authority:{...parent.authority!,automationId:'continuation-worker'},
    workDir:base.ledger.workspace.directoryFor('feedback-item'),createdAt:base.now(),updatedAt:base.now()}
  const original='authenticated request',sourceDigest='d'.repeat(64)
  const parentProduction:ContinuationProductionProof={protocol:'assistant-automations/production-occurrence/v1',automationId:parent.workerAutomationId,
    occurrenceId:`occ-${parent.id}`,taskId:'parent-task',attemptId:'parent-attempt',runId:'parent-run',executionMode:'production',status:'succeeded',
    completedAt:base.now(),quiescent:true,budgetSettlementState:'not-required',immutableContext:{state:'verified',definitionHash:'e'.repeat(64),definitionVersion:1,
      scope:{workspace:item.scope.workspace,agentPreset:item.scope.preset}}}
  const plan=createContinuationPlan(item,{sourceDigest,inputText:original,modelSelection:{provider:'frozen-provider',model:'frozen-model'}},
    {itemId:parent.id,rootItemId:parent.id,reportRevision:1,outcomeRevision:1,production:parentProduction},config,activation,schemas)
  const planJson=continuationCanonical(plan),planDigest=continuationDigest(planJson)
  base.store.admitItem(item,{kind:'admitted',actor:'admission'},
    {itemId:item.id,automationId:item.workerAutomationId,eventId:item.id,occurredAt:item.createdAt,generation:0,wakeAttempts:0,state:'pending',occurrenceId:null,reason:null,createdAt:item.createdAt,updatedAt:item.createdAt},[],undefined,
    {itemId:item.id,parentItemId:parent.id,rootItemId:parent.id,sourceKey:continuationSourceKey(parent.id,sourceDigest),sourceDigest,inputText:original,
      inputSha256:continuationDigest(original),parentReportRevision:1,parentOutcomeRevision:1,planJson,planDigest,createdAt:item.createdAt})
  base.store.markDispatchDispatched(item.id,'feedback-native-occurrence')
  base.ledger.claim({itemId:item.id,runId:'feedback-native-occurrence',occurrenceId:'feedback-native-occurrence'})
  const report=base.ledger.report({itemId:item.id,runId:'feedback-native-occurrence',status:'ready',summary:'worker result\0full-report 😀',artifactPaths:[],idempotencyKey:'feedback-ready'}).report
  const selector={itemId:item.id,reportRevision:report.revision,reportDigest:workItemReportDigest(item,report,base.store.ownerRecallText(item.id,report.revision),planDigest)}
  let production:ContinuationProductionProof|undefined={protocol:'assistant-automations/production-occurrence/v1',automationId:item.workerAutomationId,
    occurrenceId:'feedback-native-occurrence',taskId:'native-task',attemptId:'native-attempt',runId:'native-run',executionMode:'production',status:'succeeded',completedAt:base.now(),
    quiescent:true,budgetSettlementState:'finalized',immutableContext:{state:'verified',definitionHash:activation.definitionHash,definitionVersion:1,
      scope:{workspace:item.scope.workspace,agentPreset:item.scope.preset},owner:CONTINUATION_OWNER}}
  let registration:WorkItemReplyConsumerRegistration|undefined,active=true,onOwnerRead:(()=>void)|undefined,onProductionRead:(()=>void)|undefined
  const reconcile=vi.fn(),ingest=vi.fn(()=>({id:'unexpected-occurrence',automationId:'continuation-worker'})),model=vi.fn(async()=>{throw new Error('must not execute')}),reserve=vi.fn()
  let ordinary=0,typed=0
  const delivery:PeerDeliveryService={validateOwnerRoute:()=>{onOwnerRead?.();return{...owner}},enqueueBackground:()=>{ordinary++;return{id:'ordinary'}},
    workItemReplyProtocolVersion:()=>1,registerWorkItemReplyConsumer:value=>{registration=value;return()=>{if(registration===value)registration=undefined}},
    enqueueWorkItemReport:input=>{if(!registration?.inspectReport({...input,format:input.format??'plain'}))throw new Error('untrusted report');typed++;return{id:'typed'}},
    listPendingWorkItemReplies:()=>({items:[],hasMore:false,nextAfterSequence:null}),readWorkItemReply:()=>{throw new Error('no continuation source')},
    selectWorkItemReplyParent:()=>{throw new Error('no continuation source')},acknowledgeWorkItemReply:()=>{throw new Error('no continuation source')}}
  const automations:PeerAutomationsService={inspectProductionOccurrence:()=>{onProductionRead?.();return production as ReturnType<NonNullable<PeerAutomationsService['inspectProductionOccurrence']>>},
    hostAgentAuthorizationVersion:()=>1,runAgentForHostExecution:model,registerHostExecutor:()=>()=>{},reconcileSystem:reconcile as never,
    inspectSystemOwned:()=>{throw new Error('historical feedback must not inspect active automation')},inspectSystemOwnedActivation:()=>{throw new Error('must not read active activation')},ingestExternal:ingest}
  let currentDelivery:PeerDeliveryService=delivery,currentAutomations:PeerAutomationsService=automations
  const targets=new WorkItemOwnerFeedbackTargets({config,store:()=>base.store,delivery:()=>currentDelivery,automations:()=>currentAutomations,current:()=>active})
  const sql=(fn:(db:DatabaseSync)=>void)=>{const db=new DatabaseSync(config.databasePath);try{fn(db)}finally{db.close()}}
  const diagnosis=()=>{
    const diagnosticConfig=normalizeConfig({...raw,sources:{foregroundFailures:{enabled:true,kind:'review'}},diagnosis:{enabled:true,budgetId:'diagnostics',budgetAmount:1,
      maxModelCalls:4,maxToolCalls:6,maxOutputTokens:256,timeoutMs:15000,expiresAt:base.now()+3600000}},base.now())
    const source:PeerOwnerForegroundTaskSource={protocol:'assistant-delivery/owner-foreground-source/v1',inboxId:'source-inbox',sourceDigest:'2'.repeat(64),completionSequence:1,
      authorityId:owner.authorityId,authorityHash:owner.authorityHash,principalId:owner.principalId,scope:{workspace:owner.workspace,preset:owner.agentPreset},
      owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},binding:{id:parent.originBindingId,version:owner.bindingVersion,generation:owner.generation,sessionId:'source-session'},
      execution:{dispatchedAt:base.now()-10,completedAt:base.now()-1,executionRef:'source-inbox',status:'unknown',quiescent:false,modelSelectionState:'frozen',
        modelSelection:{provider:'original-diagnostic-provider',model:'original-diagnostic-model',reasoningEffort:'low'}},
      termination:{protocol:'assistant-delivery/foreground-termination/v1',producer:'delivery-agent',kind:'error',causeCode:'turn-error',handleDisposed:true,effects:'unknown',replay:'forbidden'}}
    const toolSchemas=DIAGNOSIS_TOOLS.map(name=>({name})),a={protocol:'assistant-work-items/diagnosis-activation/v1' as const,stage:'established' as const,
      configurationDigest:diagnosisConfigurationDigest(diagnosticConfig,toolSchemas),activationNonce:'3'.repeat(64),catalogDigest:'4'.repeat(64),definitionVersion:1,
      definitionHash:diagnosisDefinitionHash(diagnosisDefinition(diagnosticConfig,'3'.repeat(64),'4'.repeat(64))),reconciliationKey:'diagnostic-activation',ownerReceipt:owner}
    const row:WorkItemRecord={...item,id:'feedback-diagnosis',dedupKey:'feedback-diagnosis-key',kind:'review',externalId:diagnosisExternalId(source),
      workerAutomationId:config.workerAutomationId!,workDir:base.ledger.workspace.directoryFor('feedback-diagnosis'),authority:parent.authority}
    const plan=createDiagnosisPlan(row,source,diagnosticConfig,a,toolSchemas)
    base.store.admitItem(row,{kind:'admitted',actor:'admission',detail:{kind:row.kind,dedupBucket:row.dedupBucket,provenance:null}},
      {itemId:row.id,automationId:row.workerAutomationId,eventId:row.id,occurredAt:row.createdAt,generation:0,wakeAttempts:0,state:'pending',occurrenceId:null,reason:null,createdAt:row.createdAt,updatedAt:row.createdAt},[],plan)
    base.store.markDispatchDispatched(row.id,'diagnostic-occurrence')
    base.ledger.claim({itemId:row.id,runId:'diagnostic-occurrence',occurrenceId:'diagnostic-occurrence'})
    const report=base.ledger.report({itemId:row.id,runId:'diagnostic-occurrence',status:'failed',summary:'diagnostic failed honestly',artifactPaths:[],idempotencyKey:'diagnostic-report'}).report
    production={protocol:'assistant-automations/production-occurrence/v1',automationId:row.workerAutomationId,occurrenceId:'diagnostic-occurrence',
      taskId:'diagnostic-task',attemptId:'diagnostic-attempt',runId:'diagnostic-run',executionMode:'production',status:'failed',completedAt:base.now(),quiescent:true,budgetSettlementState:'finalized',
      immutableContext:{state:'verified',owner:DIAGNOSIS_OWNER,definitionHash:a.definitionHash,definitionVersion:1,scope:{workspace:row.scope.workspace,agentPreset:row.scope.preset}}}
    return{itemId:row.id,reportRevision:report.revision,reportDigest:workItemReportDigest(row,report,base.store.ownerRecallText(row.id,report.revision),continuationDigest(acceptanceCanonicalJson(plan)))}
  }
  return{base,raw,config,item,report,selector,plan,activation,schemas,planDigest,targets,delivery,automations,reconcile,ingest,model,reserve,sql,
    get registration(){return registration!},get production(){return production!},setProduction:(value:ContinuationProductionProof|undefined)=>{production=value},
    setOwner:(value:Partial<typeof owner>)=>{owner={...owner,...value}},onOwner:(fn:()=>void)=>{onOwnerRead=fn},onProduction:(fn:()=>void)=>{onProductionRead=fn},
    replaceDelivery:()=>{currentDelivery={...delivery}},replaceAutomations:()=>{currentAutomations={...automations}},revoke:()=>{active=false},diagnosis,counts:()=>({ordinary,typed})}
}

test('feedback is independent, default-off and digest-compatible, with unchanged past execution deadlines',async()=>{
  const f=await fixture()
  try {
    expect(f.config.ownerReplyContinuation).toBeUndefined()
    const off=normalizeConfig({...f.raw,ownerReportFeedback:false},f.base.now())
    expect(off.ownerReportFeedback).toBeUndefined()
    expect(continuationConfigurationDigest(off,f.schemas)).toBe(continuationConfigurationDigest(f.config,f.schemas))
    const diagnosisSchemas=DIAGNOSIS_TOOLS.map(name=>({name}))
    expect(diagnosisConfigurationDigest(off,diagnosisSchemas)).toBe(diagnosisConfigurationDigest(f.config,diagnosisSchemas))
    expect(()=>normalizeConfig({...f.raw,ownerContinuation:{enabled:false}},f.base.now())).toThrow(/requires configured ownerContinuation/u)
    f.base.advance(86400001)
    expect(()=>normalizeConfig({...f.raw,ownerReportFeedback:false},f.base.now())).toThrow(/future/u)
    const expired=normalizeConfig(f.raw,f.base.now())
    expect(expired.scope?.expiresAt).toBe(f.config.scope!.expiresAt);expect(expired.ownerContinuation?.expiresAt).toBe(f.config.ownerContinuation!.expiresAt)
  }finally{f.targets.close()}
})

test('opaque proof preserves exact full report/task bytes and actual terminal execution status',async()=>{
  const f=await fixture()
  try {
    for(const [status,expected]of [['succeeded','succeeded'],['failed','failed'],['timed_out','timed-out'],['cancelled','cancelled']] as const) {
      f.setProduction({...f.production,status})
      const cap=f.targets.issue(f.selector),proof=f.targets.resolve(cap)!
      expect(proof).toBeDefined();expect(proof.production.executionStatus).toBe(expected)
      expect(proof.report.text).toBe('worker result\0full-report 😀');expect(proof.task.brief).toBe('original task\0full-tail 😀')
      expect(proof.supplier).toEqual({provider:'frozen-provider',model:'frozen-model'})
      const{proofDigest,...unsigned}=proof;expect(proofDigest).toBe(acceptanceDigest(unsigned))
      expect(Object.isFrozen(proof.report)).toBe(true);expect(f.targets.resolve(JSON.parse(JSON.stringify(cap)))).toBeUndefined()
    }
    expect(f.reconcile).not.toHaveBeenCalled();expect(f.ingest).not.toHaveBeenCalled();expect(f.model).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled()
  }finally{f.targets.close()}
})

test('unknown/non-quiescent, unsettled, foreign and corrupted production proofs cannot issue a capability',async()=>{
  const f=await fixture()
  try {
    const valid=f.production
    for(const invalid of [undefined,{...valid,status:'unknown'},{...valid,quiescent:false},{...valid,budgetSettlementState:'unknown'},
      {...valid,budgetSettlementState:'not-required'},{...valid,executionMode:'preview'},{...valid,occurrenceId:'foreign-occurrence'},
      {...valid,automationId:'foreign-worker'},{...valid,runId:'run\0hidden'},{...valid,immutableContext:{...valid.immutableContext,owner:'foreign'}},
      {...valid,immutableContext:{...valid.immutableContext,definitionHash:'0'.repeat(64)}},
      {...valid,immutableContext:{...valid.immutableContext,definitionVersion:2}},
      {...valid,immutableContext:{...valid.immutableContext,scope:{workspace:'/foreign',agentPreset:'primary'}}}]) {
      f.setProduction(invalid as ContinuationProductionProof|undefined);expect(f.targets.issue(f.selector)).toBeUndefined()
    }
    f.setProduction(valid);expect(f.targets.issue(f.selector)).toBeDefined()
  }finally{f.targets.close()}
})

test('exact selectors reject a changed digest or superseded revision rather than switching to latest',async()=>{
  const f=await fixture()
  try {
    expect(f.targets.issue({...f.selector,reportRevision:999})).toBeUndefined()
    expect(f.targets.issue({...f.selector,reportDigest:'0'.repeat(64)})).toBeUndefined()
    const cap=f.targets.issue(f.selector)
    f.sql(db=>db.exec(`INSERT INTO work_item_report(item_id,revision,status,summary,truncated,artifact_paths,idempotency_key,delivery_key,delivery_state,delivery_id,recorded_at)
      SELECT item_id,revision+1,status,'new terminal report',truncated,artifact_paths,idempotency_key||'new',delivery_key||'new',NULL,NULL,recorded_at FROM work_item_report WHERE item_id='feedback-item'`))
    expect(f.targets.issue(f.selector)).toBeUndefined();expect(f.targets.resolve(cap)).toBeUndefined()
  }finally{f.targets.close()}
})

test('owner replacement and provider-generation replacement invalidate capabilities while a new same-owner session can read',async()=>{
  for(const change of ['owner','delivery','automations','session']as const) {
    const f=await fixture()
    try {
      const cap=f.targets.issue(f.selector)
      if(change==='owner')f.setOwner({principalRecordId:'different-owner'})
      if(change==='delivery')f.replaceDelivery()
      if(change==='automations')f.replaceAutomations()
      if(change==='session')f.setOwner({generation:3,bindingVersion:1})
      expect(f.targets.resolve(cap)!==undefined).toBe(change==='session')
      if(change==='owner')expect(f.targets.issue(f.selector)).toBeUndefined()
    }finally{f.targets.close()}
  }
})

test('the final local read rejects report mutation or service disposal inside the last owner callback',async()=>{
  for(const change of ['report','dispose','owner']as const) {
    const f=await fixture()
    try {
      let calls=0
      f.onOwner(()=>{if(++calls!==2)return
        if(change==='report')f.sql(db=>db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('worker result\0changed hidden tail','feedback-item'))
        if(change==='dispose')f.targets.close()
        if(change==='owner')f.setOwner({principalVersion:999})
      })
      expect(f.targets.issue(f.selector)).toBeUndefined()
    }finally{f.targets.close()}
  }
})

test('metadata can be typed before quiescence in feedback-only mode without granting continuation',async()=>{
  const f=await fixture()
  let consumer:WorkItemOwnerReplies|undefined
  try {
    const dispatch=new WorkItemDispatch({config:f.config,store:f.base.store,ledger:f.base.ledger,delivery:f.delivery,automations:undefined,
      replyReportEligible:(item,report,notification)=>consumer!.canEnqueue(item,report,notification)})
    consumer=new WorkItemOwnerReplies({config:f.config,store:f.base.store,delivery:()=>f.delivery,runtime:()=>undefined,
      admit:()=>{throw new Error('feedback must not admit')},notification:(item,report)=>dispatch.notification(item,report),retire:()=>{},
      inspectFeedbackReport:input=>f.targets.inspectReport(input,(item,report)=>dispatch.notification(item,report))})
    f.setProduction(undefined);consumer.start()
    expect(f.registration).toMatchObject({continuationEnabled:false,feedbackEnabled:true})
    expect(await dispatch.notify(f.base.store.findItemById(f.item.id)!,f.report)).toBe(true)
    expect(f.counts()).toEqual({ordinary:0,typed:1});expect(f.targets.issue(f.selector)).toBeUndefined()
    const notification=dispatch.notification(f.item,f.report)
    expect(f.registration.canContinueReport?.({itemId:f.item.id,reportRevision:1,bindingId:f.item.originBindingId,idempotencyKey:f.report.deliveryKey,text:notification.text,format:'markdown'})).toBe(false)
    expect(f.model).not.toHaveBeenCalled();expect(f.ingest).not.toHaveBeenCalled()
  }finally{consumer?.close();f.targets.close()}
})

test('cold service startup with expired grants still proves history without reconciling or executing',async()=>{
  const f=await fixture(),ctx=new Context()
  try {
    f.base.advance(1);const queued=await admitted(f.base)
    f.base.advance(86400001)
    await mountAgentLoopTestDependencies(ctx,{systemPrompt:{personaPrefix:''}})
    ctx.provide('assistantPolicy',f.base.policy.service as never)
    ctx.provide('assistantDelivery',f.delivery as never);ctx.provide('assistantAutomations',f.automations as never)
    await ctx.plugin(AssistantWorkItemsService,f.raw)
    const service=ctx.assistantWorkItems,cap=service.issueOwnerWorkItemFeedbackTarget(f.selector)
    expect(service.resolveOwnerWorkItemFeedbackTarget(cap)?.production.executionStatus).toBe('succeeded')
    expect(service.health().ownerContinuation?.ready).toBe(false)
    expect(f.base.store.findItemById(queued.id)?.state).toBe('queued')
    expect(f.reconcile).not.toHaveBeenCalled();expect(f.ingest).not.toHaveBeenCalled();expect(f.model).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled()
    service.close();expect(service.resolveOwnerWorkItemFeedbackTarget(cap)).toBeUndefined()
  }finally{await ctx.fiber.restart();f.targets.close()}
})

test('closing or replacing the historical reader rejects old opaque values',async()=>{
  const f=await fixture()
  try {
    const cap=f.targets.issue(f.selector)
    f.targets.close();expect(f.targets.resolve(cap)).toBeUndefined()
    const fresh=new WorkItemOwnerFeedbackTargets({config:f.config,store:()=>f.base.store,delivery:()=>f.delivery,automations:()=>f.automations,current:()=>true})
    try{expect(fresh.resolve(cap)).toBeUndefined();expect(fresh.resolve(fresh.issue(f.selector))).toBeDefined()}finally{fresh.close()}
  }finally{f.targets.close()}
})

test('both features keep historical metadata after expiry while ordinary continuation eligibility stops',async()=>{
  const f=await fixture({ownerReplyContinuation:true})
  let consumer:WorkItemOwnerReplies|undefined
  try {
    const dispatch=new WorkItemDispatch({config:f.config,store:f.base.store,ledger:f.base.ledger,delivery:f.delivery,automations:undefined,
      replyReportEligible:(item,report,notification)=>consumer!.canEnqueue(item,report,notification)})
    const runtime={canAcceptReportReply:()=>f.base.now()<f.config.ownerContinuation!.expiresAt,wakePending:()=>{}} as unknown as WorkItemContinuation
    consumer=new WorkItemOwnerReplies({config:f.config,store:f.base.store,delivery:()=>f.delivery,runtime:()=>runtime,
      admit:()=>{throw new Error('metadata test must not execute')},notification:(item,report)=>dispatch.notification(item,report),retire:()=>{},
      inspectFeedbackReport:input=>f.targets.inspectReport(input,(item,report)=>dispatch.notification(item,report))})
    consumer.start()
    const complete=f.base.store.feedbackReportByRevision(f.item.id,1)!,notification=dispatch.notification(f.base.store.findItemById(f.item.id)!,complete)
    const input={itemId:f.item.id,reportRevision:1,bindingId:f.item.originBindingId,idempotencyKey:complete.deliveryKey,text:notification.text,format:'markdown' as const}
    expect(f.registration).toMatchObject({continuationEnabled:true,feedbackEnabled:true})
    expect(f.registration.canContinueReport?.(input)).toBe(true)
    f.base.advance(3600001)
    expect(f.registration.inspectReport(input)).toBeDefined();expect(f.registration.canContinueReport?.(input)).toBe(false)
    expect(f.targets.resolve(f.targets.issue(f.selector))).toBeDefined()
    expect(f.ingest).not.toHaveBeenCalled();expect(f.model).not.toHaveBeenCalled()
  }finally{consumer?.close();f.targets.close()}
})

test('mutable outbox bookkeeping does not invalidate proof but changed immutable report bytes do',async()=>{
  const f=await fixture()
  try {
    const cap=f.targets.issue(f.selector),proof=f.targets.resolve(cap)!
    f.base.ledger.recordDelivery(f.item.id,1,'sent','new-outbox-receipt')
    expect(f.targets.resolve(cap)?.proofDigest).toBe(proof.proofDigest)
    f.sql(db=>db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('worker result\0different hidden suffix','feedback-item'))
    expect(f.targets.resolve(cap)).toBeUndefined()
  }finally{f.targets.close()}
})

test('diagnostic feedback uses its exact original producer and frozen supplier, including failed execution',async()=>{
  const f=await fixture()
  try {
    const selector=f.diagnosis(),valid=f.production
    for(const immutableContext of [{...valid.immutableContext,owner:CONTINUATION_OWNER},{...valid.immutableContext,definitionHash:'0'.repeat(64)},
      {...valid.immutableContext,definitionVersion:2}]) {
      f.setProduction({...valid,immutableContext});expect(f.targets.issue(selector)).toBeUndefined()
    }
    f.setProduction(valid)
    const proof=f.targets.resolve(f.targets.issue(selector))!
    expect(proof.production.executionStatus).toBe('failed');expect(proof.report.status).toBe('failed')
    expect(proof.supplier).toEqual({provider:'original-diagnostic-provider',model:'original-diagnostic-model',reasoningEffort:'low'})
  }finally{f.targets.close()}
})

test('foreign proof accessors are rejected without executing them after a local evidence fence',async()=>{
  const f=await fixture()
  try {
    const observed={...f.production},getter=vi.fn(()=>{f.targets.close();return'native-run'})
    Object.defineProperty(observed,'runId',{enumerable:true,get:getter})
    f.setProduction(observed)
    expect(f.targets.issue(f.selector)).toBeUndefined();expect(getter).not.toHaveBeenCalled()
  }finally{f.targets.close()}
})
