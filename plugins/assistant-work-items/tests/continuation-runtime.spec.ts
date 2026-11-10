import type { Context } from '@deepseek-ai/cordis'
import type { HostAgentExecutionContract, HostAutomationDefinition, HostAutomationExecutor, HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { WorkItemContinuation } from '../src/continuation.ts'
import { CONTINUATION_OWNER, continuationDefinitionHash, parseContinuationPlan, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { normalizeConfig } from '../src/config.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemRecord, WorkItemDispatchRecord } from '../src/types.ts'
import { admitted, harness, readyItem, receipt } from './fixtures.ts'

// Component tests: real SQLite/claim/report state, recorded Host/Delivery/Policy
// protocol fixtures. They do not establish native Agent execution or real owner intake.
afterEach(()=>vi.restoreAllMocks())
async function fixture() {
  const f=await harness(),parent=await readyItem(f)
  vi.spyOn(Date,'now').mockImplementation(f.now)
  const config={...normalizeConfig({enabled:true,mode:'active',databasePath:f.config.databasePath,workRoot:f.config.workRoot,
    intakeSourceId:f.config.intakeSourceId,workerAutomationId:f.config.workerAutomationId!,scope:f.config.scope!,ownerRecall:{enabled:true},
    admission:{...f.config.admission,allowedKinds:[...f.config.admission.allowedKinds,'owner-continuation']},ownerContinuation:{enabled:true,automationId:'continuation-worker',
      allowedTools:['work_item_claim','work_item_report','work_item_read_context','execute'],budgetId:'continuation-budget',budgetAmount:1,
      maxModelCalls:8,maxToolCalls:20,maxOutputTokens:256,timeoutMs:15000,expiresAt:f.now()+3600000}},f.now())}
  let owner=receipt({authorityId:config.scope!.ownerRouteId,principalId:config.scope!.principalId,workspace:config.scope!.workspace,agentPreset:config.scope!.preset})
  const schemas=config.ownerContinuation!.allowedTools.map(name=>({name,description:name,parameters:{type:'object',additionalProperties:false}}))
  const state:{definition?:HostAutomationDefinition;status:string;executor?:HostAutomationExecutor;proofs:Map<string,ContinuationProductionProof>;
    model:(input:HostAutomationExecutorInput)=>Promise<{outcome:string;quiescent:boolean}>}={status:'active',proofs:new Map(),model:async()=>({outcome:'unknown',quiescent:false})}
  const proof=(item:WorkItemRecord,occurrenceId:string):ContinuationProductionProof=>({protocol:'assistant-automations/production-occurrence/v1',
    automationId:item.workerAutomationId,occurrenceId,taskId:`task-${occurrenceId}`,attemptId:`attempt-${occurrenceId}`,runId:`run-${occurrenceId}`,
    executionMode:'production',status:'succeeded',completedAt:f.now(),quiescent:true,budgetSettlementState:'finalized',
    immutableContext:{state:'verified',definitionHash:item.workerAutomationId==='continuation-worker'&&state.definition?continuationDefinitionHash(state.definition):'a'.repeat(64),definitionVersion:1,scope:{workspace:item.scope.workspace,agentPreset:item.scope.preset},...(item.workerAutomationId==='continuation-worker'?{owner:CONTINUATION_OWNER}:{})}})
  state.proofs.set(`occ-${parent.id}`,proof(parent,`occ-${parent.id}`))
  const reconcile=vi.fn((input:{definition:HostAutomationDefinition})=>{state.definition=input.definition})
  const runAgent=vi.fn((input:HostAutomationExecutorInput,_contract:HostAgentExecutionContract)=>state.model(input))
  const automations={hostAgentAuthorizationVersion:()=>1,runAgentForHostExecution:runAgent,
    registerHostExecutor:(executor:HostAutomationExecutor)=>{state.executor=executor;return()=>{if(state.executor===executor) delete state.executor}},
    reconcileSystem:reconcile,
    inspectSystemOwned:()=>{
      if(!state.definition) throw Object.assign(new Error('not found'),{code:'not-found'})
      return {owner:CONTINUATION_OWNER,automationId:'continuation-worker',automationStatus:state.status,
        definitionHash:continuationDefinitionHash(state.definition),definitionVersion:1}
    },inspectSystemOwnedActivation:()=>state.definition?{definitionHash:continuationDefinitionHash(state.definition),
      activationNonce:state.definition.execution.activationNonce,ownerRouteId:config.scope!.ownerRouteId}:undefined,
    inspectProductionOccurrence:(input:{occurrenceId:string})=>state.proofs.get(input.occurrenceId)}
  const delivery={validateOwnerRoute:()=>owner}
  const context={get:(name:string)=>({assistantAutomations:automations,assistantDelivery:delivery,assistantPolicy:f.policy.service})[name as 'assistantAutomations'],
    tools:{schemas:()=>schemas}} as unknown as Context
  let sequence=0,wakes=0,runtime:WorkItemContinuation
  const hooks={assertOwner:(item:WorkItemRecord)=>{
    if(item.owner.generation!==owner.generation || item.owner.bindingVersion!==owner.bindingVersion
      || item.owner.principalRecordId!==owner.principalRecordId || item.owner.principalVersion!==owner.principalVersion) throw new Error('owner differs')
    return owner
  },assertMandate:()=>{if(f.policy.decision.effect!=='allow') throw new Error('mandate revoked')},wake:(item:WorkItemRecord)=>{
    if(!runtime.validateWake(item)) return false
    wakes++;f.store.markDispatchDispatched(item.id,`continuation-occ-${wakes}`);return true
  }}
  runtime=new WorkItemContinuation(context,config,f.store,hooks)
  const makeChild=(sourceDigest='b'.repeat(64),inputText='接着修复前次任务😀\0完整')=>{
    const mint=runtime.prepare(parent.id,{sourceDigest,inputText,modelSelection:{provider:'human-provider',model:'human-model',reasoningEffort:'high'}},()=>{})
    sequence++
    const item:WorkItemRecord={...f.store.findItemById(parent.id)!,id:`continuation-child-${sequence}`,dedupKey:`child-key-${sequence}`,externalId:`child-source-${sequence}`,
      workerAutomationId:'continuation-worker',state:'queued',stateReason:null,attempt:0,maxAttempts:1,lastReportStatus:null,leaseUntil:null,leaseRunId:null,occurrenceId:null,
      scope:config.scope!,owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion,workspace:owner.workspace,agentPreset:owner.agentPreset,
        generation:owner.generation,bindingVersion:owner.bindingVersion},originBindingId:parent.originBindingId,
      workDir:f.ledger.workspace.directoryFor(`continuation-child-${sequence}`),createdAt:f.now()+sequence,updatedAt:f.now()+sequence}
    const dispatch:WorkItemDispatchRecord={itemId:item.id,automationId:item.workerAutomationId,eventId:item.id,occurredAt:item.createdAt,generation:0,wakeAttempts:0,
      state:'pending',occurrenceId:null,reason:null,createdAt:item.createdAt,updatedAt:item.createdAt}
    f.store.admitItem(item,{kind:'admitted',actor:'admission'},dispatch,[],undefined,mint.create(item))
    return item
  }
  const input=(item:WorkItemRecord):HostAutomationExecutorInput=>({occurrenceId:f.store.getDispatch(item.id)!.occurrenceId!,automationId:'continuation-worker',
    definitionHash:continuationDefinitionHash(state.definition!),executionMode:'production',targetScope:{workspace:config.scope!.workspace,preset:config.scope!.preset},
    principal:config.scope!.principalId,ownerRouteId:config.scope!.ownerRouteId,activationNonce:state.definition!.execution.activationNonce,
    catalogDigest:state.definition!.execution.catalogDigest,signal:new AbortController().signal})
  const mount=()=>{runtime=new WorkItemContinuation(context,config,f.store,hooks);runtime.start();return runtime}
  runtime.start()
  return {...f,config,parent,state,schemas,reconcile,runAgent,proof,makeChild,input,mount,get runtime(){return runtime},
    owner:(value:Partial<typeof owner>)=>{owner={...owner,...value}},wakes:()=>wakes}
}

test('activation is distinct, persistent, and permits the same owner lineage after /new without recreating the worker',async()=>{
  const f=await fixture()
  try {
    expect(f.reconcile).toHaveBeenCalledTimes(1)
    expect(f.state.definition).toMatchObject({retrySafety:'never',maxRetries:0,budgetId:'continuation-budget',execution:{executorId:'work-items/owner-continuation/v1'}})
    const before=f.store.meta('continuation.activation/v1')
    f.runtime.close();f.owner({generation:3,bindingVersion:1});f.mount()
    expect(f.reconcile).toHaveBeenCalledTimes(1);expect(f.store.meta('continuation.activation/v1')).toBe(before)
    expect(f.runtime.health()).toMatchObject({ready:true,running:0})
  } finally {f.runtime.close()}
})

test('paused or established missing activation stays unavailable and never unpauses or recreates',async()=>{
  for(const status of ['paused','missing']) {
    const f=await fixture()
    try {
      const before=f.store.meta('continuation.activation/v1');f.runtime.close()
      if(status==='missing') delete f.state.definition;else f.state.status=status
      expect(()=>f.mount()).toThrow();expect(f.reconcile).toHaveBeenCalledTimes(1)
      expect(f.store.meta('continuation.activation/v1')).toBe(before)
    } finally {f.runtime.close()}
  }
})

test('a terminal worker report without exact quiescence and finalized budget cannot mint a continuation',async()=>{
  const f=await fixture()
  try {
    const key=`occ-${f.parent.id}`,valid=f.state.proofs.get(key)!
    for(const bad of [undefined,{...valid,occurrenceId:'wrong'},{...valid,status:'unknown'},{...valid,quiescent:false},
      {...valid,executionMode:'preview'},{...valid,budgetSettlementState:'unknown'},
      {...valid,immutableContext:{...valid.immutableContext,scope:{workspace:'/other',agentPreset:'primary'}}}]) {
      if(bad) f.state.proofs.set(key,bad as ContinuationProductionProof);else f.state.proofs.delete(key)
      expect(()=>f.makeChild()).toThrow();expect(f.store.listPendingContinuations('continuation-worker')).toEqual([])
    }
    f.state.proofs.set(key,valid);expect(f.makeChild().workerAutomationId).toBe('continuation-worker')
    f.state.proofs.set(key,{...valid,budgetSettlementState:'not-required'})
    expect(f.makeChild('e'.repeat(64)).workerAutomationId).toBe('continuation-worker')
    f.advance(1000)
    const open=await admitted(f)
    expect(()=>f.runtime.prepare(open.id,{sourceDigest:'a'.repeat(64),inputText:'continue',modelSelection:{provider:'p',model:'m'}},()=>{})).toThrow(/terminal/u)
  } finally {f.runtime.close()}
})

test('freezes current instruction supplier, explicit effort and complete UTF-8 input in a cold-readable canonical plan',async()=>{
  const f=await fixture()
  try {
    const item=f.makeChild(),record=f.store.getContinuation(item.id)!,plan=parseContinuationPlan(record.planJson)
    expect(plan.contract).toMatchObject({provider:'human-provider',model:'human-model',reasoningEffort:'high',maxModelCalls:8,maxToolCalls:20})
    expect(plan.parent).toMatchObject({itemId:f.parent.id,rootItemId:f.parent.id,reportRevision:1,outcomeRevision:1})
    expect(record.inputText).toBe('接着修复前次任务😀\0完整')
    const cold=new WorkItemStore(f.config.databasePath,{now:f.now})
    try {expect(cold.getContinuation(item.id)).toEqual(record)} finally {cold.close()}
    expect(f.runAgent).not.toHaveBeenCalled()
  } finally {f.runtime.close()}
})

test('freezes required acceptance per continuation and rejects invalid objectives without changing old plans',async()=>{
  const f=await fixture()
  try {
    const legacy=f.makeChild('1'.repeat(64))
    const legacyBytes=f.store.getContinuation(legacy.id)!.planJson
    expect(parseContinuationPlan(legacyBytes).contract.acceptance).toBeUndefined()
    Object.assign(f.config,{acceptanceHoldReport:{holdTimeoutMs:60_000}})
    expect(f.runtime.validateWake(legacy)).toBe(true)
    expect(f.store.getContinuation(legacy.id)!.planJson).toBe(legacyBytes)
    const sourceDigest='2'.repeat(64), objective='  '+ '界'.repeat(2729)+' 😀\n'
    expect(Buffer.byteLength(objective)).toBe(8195)
    expect(()=>f.makeChild(sourceDigest,objective)).toThrow(/8192 UTF-8 bytes/u)
    expect(()=>f.makeChild(sourceDigest,' \t\n ')).toThrow(/nonblank/u)
    expect(()=>f.makeChild(sourceDigest,'owner\0input')).toThrow(/NUL-free/u)
    const exact='  '+'界'.repeat(2728)+' 😀\n'
    expect(Buffer.byteLength(exact)).toBe(8192)
    const required=f.makeChild(sourceDigest,exact)
    const plan=parseContinuationPlan(f.store.getContinuation(required.id)!.planJson)
    expect(plan.contract.acceptance).toEqual({required:true,objective:exact,sourceDigest})
    expect(f.runtime.validateWake(required)).toBe(true)
    Reflect.deleteProperty(f.config,'acceptanceHoldReport')
    expect(f.runtime.validateWake(required)).toBe(false)
    expect(f.runtime.isWakeCurrent(required)).toBe(false)
    expect(f.runtime.validateWake(legacy)).toBe(true)
    expect(f.runAgent).not.toHaveBeenCalled()
  } finally {f.runtime.close()}
})

test('admission callbacks recheck owner and parent after preparation rather than trusting an earlier decision',async()=>{
  const f=await fixture()
  try {
    let current=true
    const mint=f.runtime.prepare(f.parent.id,{sourceDigest:'d'.repeat(64),inputText:'continue',modelSelection:{provider:'p',model:'m'}},()=>{if(!current) throw new Error('owner revoked')})
    current=false
    expect(()=>mint.create({...f.parent,id:'forged-child'})).toThrow(/owner revoked/u)
    f.owner({principalRecordId:'different-owner'})
    expect(()=>f.makeChild()).toThrow(/receipt changed/u)
  } finally {f.runtime.close()}
})

test('serialized wake holds the second child until the first exact outer production receipt exists',async()=>{
  const f=await fixture()
  try {
    const first=f.makeChild('1'.repeat(64)),second=f.makeChild('2'.repeat(64))
    f.runtime.wakePending();expect(f.wakes()).toBe(1);expect(f.store.getDispatch(second.id)?.state).toBe('pending')
    f.ledger.claim({itemId:first.id,runId:'continuation-occ-1',occurrenceId:'continuation-occ-1'})
    f.ledger.report({itemId:first.id,runId:'continuation-occ-1',status:'ready',summary:'a worker claim',artifactPaths:[],idempotencyKey:'ready'})
    f.runtime.wakePending();expect(f.wakes()).toBe(1)
    const valid=f.proof(first,'continuation-occ-1')
    f.state.proofs.set('continuation-occ-1',{...valid,budgetSettlementState:'not-required'})
    f.runtime.wakePending();expect(f.wakes()).toBe(1)
    for(const immutableContext of [{...valid.immutableContext,definitionHash:'e'.repeat(64)},
      {...valid.immutableContext,definitionVersion:2},{...valid.immutableContext,owner:'other-worker'}]) {
      f.state.proofs.set('continuation-occ-1',{...valid,immutableContext});f.runtime.wakePending();expect(f.wakes()).toBe(1)
    }
    f.state.proofs.set('continuation-occ-1',valid);f.runtime.wakePending();expect(f.wakes()).toBe(2)
    expect(f.store.getDispatch(second.id)?.occurrenceId).toBe('continuation-occ-2')
  } finally {f.runtime.close()}
})

test('a send with unknown outcome blocks later children, including after cold runtime restart',async()=>{
  const f=await fixture()
  try {
    const first=f.makeChild('1'.repeat(64)),second=f.makeChild('2'.repeat(64))
    f.store.markDispatchUnknown(first.id);f.runtime.wakePending();expect(f.wakes()).toBe(0)
    expect(f.store.getDispatch(second.id)?.state).toBe('pending');expect(f.runtime.health().interventionRequired).toBe(true)
    f.runtime.close();f.mount();expect(f.wakes()).toBe(0)
    expect(f.store.getDispatch(first.id)).toMatchObject({state:'failed',reason:'unknown_after_send',wakeAttempts:1})
  } finally {f.runtime.close()}
})

test('live component execution reads paged frozen history and stops tools after reporting',async()=>{
  const f=await fixture()
  try {
    const text='😀'.repeat(2500)+'\0尾部',item=f.makeChild('3'.repeat(64),text)
    f.runtime.wakePending()
    let read=''
    f.state.model=async input=>{
      f.runtime.assertTool(input.occurrenceId,'work_item_claim')
      f.ledger.claim({itemId:item.id,runId:input.occurrenceId,occurrenceId:input.occurrenceId})
      let offset=0
      do {
        const page=f.runtime.readContext(input.occurrenceId,{kind:'input',offset,maxBytes:4096})
        read+=page.text;offset=page.nextOffset??text.length*4
        expect(page).toMatchObject({parentItemId:f.parent.id,rootItemId:f.parent.id})
        if(page.nextOffset===undefined) break
      } while(offset<Buffer.byteLength(text))
      expect(()=>f.runtime.readContext(input.occurrenceId,{offset:1})).toThrow(/UTF-8/u)
      expect(f.runtime.readContext(input.occurrenceId,{kind:'parent-report',revision:1}).text).toContain('worker reported ready')
      expect(()=>f.runtime.readContext(input.occurrenceId,{kind:'parent-report',revision:2})).toThrow()
      f.runtime.assertTool(input.occurrenceId,'execute')
      const reported=f.ledger.report({itemId:item.id,runId:input.occurrenceId,status:'ready',summary:'done',artifactPaths:[],idempotencyKey:'continuation-ready'})
      f.runtime.reported(input.occurrenceId,'ready',reported.report.revision)
      expect(()=>f.runtime.assertTool(input.occurrenceId,'execute')).toThrow(/phase/u)
      return {outcome:'succeeded',quiescent:true}
    }
    const result=await f.state.executor!.execute(f.input(item))
    expect(read).toBe(text);expect(result).toMatchObject({outcome:'succeeded',sideEffectState:'possible',retryability:'unsafe'});expect(f.runAgent).toHaveBeenCalledTimes(1)
    expect(()=>f.runtime.readContext('continuation-occ-1',{})).toThrow(/live Host/u)
  } finally {f.runtime.close()}
})

test('a durable bounded pending cursor reaches a current child behind more than ten stale generations',async()=>{
  const f=await fixture()
  try {
    for(let i=1;i<=11;i++) f.makeChild(i.toString(16).padStart(64,'0'))
    f.owner({generation:3,bindingVersion:1})
    const current=f.makeChild('f'.repeat(64))
    f.runtime.wakePending();expect(f.wakes()).toBe(0)
    expect(f.store.getDispatch(current.id)?.state).toBe('pending')
    const cursor=f.store.meta('continuation.pending-cursor/v1')
    expect(cursor).toContain('continuation-child-10')
    f.runtime.close();f.mount()
    expect(f.wakes()).toBe(1);expect(f.store.getDispatch(current.id)?.state).toBe('dispatched')
    expect(f.store.getDispatch('continuation-child-1')?.state).toBe('pending')
  } finally {f.runtime.close()}
})

test('unknown teardown is persisted and never automatically reclaims or replays the one-shot',async()=>{
  const f=await fixture()
  try {
    const item=f.makeChild();f.runtime.wakePending()
    f.state.model=async input=>{
      f.ledger.claim({itemId:item.id,runId:input.occurrenceId,occurrenceId:input.occurrenceId})
      return {outcome:'unknown',quiescent:false}
    }
    expect((await f.state.executor!.execute(f.input(item))).outcome).toBe('unknown')
    expect(f.store.events(item.id).some(row=>row.kind==='continuation-unknown')).toBe(true)
    f.advance(f.config.limits.leaseMs+1);f.ledger.recover();f.runtime.wakePending()
    expect(f.store.findItemById(item.id)?.attempt).toBe(1);expect(f.wakes()).toBe(1)
    expect(()=>f.ledger.claim({itemId:item.id,runId:'replacement',occurrenceId:'replacement'})).toThrow()
  } finally {f.runtime.close()}
})

test('mutable tool schemas or stored activation drift revoke a frozen execution before any model call',async()=>{
  for(const drift of ['schema','activation']) {
    const f=await fixture()
    try {
      const item=f.makeChild();f.runtime.wakePending()
      if(drift==='schema') f.schemas[0]!.description='new schema'
      else {
        const db=new DatabaseSync(f.config.databasePath)
        try {const value=JSON.parse(f.store.meta('continuation.activation/v1')!);value.activationNonce='e'.repeat(64)
          db.prepare('UPDATE work_item_schema_meta SET value=? WHERE key=?').run(JSON.stringify(value),'continuation.activation/v1')
        } finally {db.close()}
      }
      expect((await f.state.executor!.execute(f.input(item))).outcome).toBe('failed');expect(f.runAgent).not.toHaveBeenCalled()
    } finally {f.runtime.close()}
  }
})
