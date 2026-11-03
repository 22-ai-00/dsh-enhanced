import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import type { Context } from '@deepseek-ai/cordis'
import type { HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { WorkItemContinuation } from '../src/continuation.ts'
import { CONTINUATION_OWNER, continuationDefinitionHash, continuationItemBasis, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { normalizeConfig } from '../src/config.ts'
import { expect, test, vi } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { continuationDigest, continuationSourceKey, validateContinuationInput, type WorkItemContinuationInput } from '../src/continuation-record.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemDispatchRecord, WorkItemRecord } from '../src/types.ts'
import { admitted, claim, deliveryPeer, harness, readyItem, receipt, report, signal, type Harness } from './fixtures.ts'

function child(f: Harness, parent: WorkItemRecord, id = 'continuation-child', overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {...parent,id,dedupKey:`key-${id}`,externalId:`source-${id}`,workerAutomationId:'continuation-worker',state:'queued',stateReason:null,attempt:0,leaseUntil:null,leaseRunId:null,occurrenceId:null,lastReportStatus:null,
    workDir:f.ledger.workspace.directoryFor(id),createdAt:f.now()+1,updatedAt:f.now()+1,...overrides}
}
function record(parent: WorkItemRecord, item: WorkItemRecord, overrides: Partial<WorkItemContinuationInput> = {}): WorkItemContinuationInput {
  const inputText = '请接着做\0完整输入😀', planJson = acceptanceCanonicalJson({supplier:{provider:'provider',model:'model'},budget:{amount:1},parent:parent.id})
  const sourceDigest = 'c'.repeat(64)
  return {itemId:item.id,parentItemId:parent.id,rootItemId:parent.id,sourceKey:continuationSourceKey(parent.id,sourceDigest),sourceDigest,inputText,inputSha256:continuationDigest(inputText),
    parentReportRevision:1,parentOutcomeRevision:1,planJson,planDigest:continuationDigest(planJson),createdAt:item.createdAt,...overrides}
}
function dispatch(item: WorkItemRecord): WorkItemDispatchRecord { return {itemId:item.id,automationId:item.workerAutomationId,eventId:item.id,occurredAt:item.createdAt,generation:0,wakeAttempts:0,state:'pending',occurrenceId:null,reason:null,createdAt:item.createdAt,updatedAt:item.createdAt} }
function insert(f: Harness, item: WorkItemRecord, frozen: WorkItemContinuationInput) { return f.store.admitItem(item,{kind:'admitted',actor:'admission',detail:{kind:item.kind}},dispatch(item),[],undefined,frozen) }
function sql(path: string, fn: (db: DatabaseSync) => void) {const db = new DatabaseSync(path);try {fn(db)} finally {db.close()}}

test('schema 8 upgrades additively to 9 and a cold reopen preserves complete continuation bytes and parent history', async () => {
  const f = await harness(), parent = await readyItem(f), before = {item:f.store.findItemById(parent.id),reports:f.store.reports(parent.id),outcomes:f.store.outcomes(parent.id)}
  f.store.close()
  sql(f.config.databasePath,db => {db.exec("DROP TRIGGER work_item_continuation_no_update; DROP TRIGGER work_item_continuation_no_delete; DROP TABLE work_item_continuation; UPDATE work_item_schema_meta SET value='8' WHERE key='schema_version'; PRAGMA user_version=8;")})
  const upgraded = new WorkItemStore(f.config.databasePath,{now:f.now})
  const item = child(f,parent), frozen = record(parent,item)
  try {
    expect(upgraded.stats().schemaVersion).toBe(9)
    upgraded.admitItem(item,{kind:'admitted',actor:'admission'},dispatch(item),[],undefined,frozen)
    expect(upgraded.getContinuation(item.id)).toEqual({...frozen,inputBytes:Buffer.byteLength(frozen.inputText,'utf8')})
    expect({item:upgraded.findItemById(parent.id),reports:upgraded.reports(parent.id),outcomes:upgraded.outcomes(parent.id)}).toEqual(before)
  } finally {upgraded.close()}
  const cold = new WorkItemStore(f.config.databasePath,{now:f.now})
  try {expect(cold.getContinuation(item.id)?.inputText).toBe(frozen.inputText);expect(cold.findContinuationBySourceKey(frozen.sourceKey)?.itemId).toBe(item.id)} finally {cold.close()}
})

test('source identity is globally idempotent, immutable, and cannot be grafted onto a different parent', async () => {
  const f = await harness(), parent = await readyItem(f), item = child(f,parent), frozen = record(parent,item)
  expect(insert(f,item,frozen).id).toBe(item.id)
  const other = child(f,parent,'second-child',{dedupBucket:item.dedupBucket+1,createdAt:item.createdAt+999,updatedAt:item.updatedAt+999})
  expect(insert(f,other,record(parent,other)).id).toBe(item.id)
  expect(f.store.findItemById(other.id)).toBeUndefined()
  expect(f.store.events(item.id)).toHaveLength(1)
  sql(f.config.databasePath,db => {
    expect(() => db.prepare('UPDATE work_item_continuation SET input_sha256=? WHERE item_id=?').run('d'.repeat(64),item.id)).toThrow(/append-only/u)
    expect(() => db.prepare('DELETE FROM work_item_continuation WHERE item_id=?').run(item.id)).toThrow(/append-only/u)
  })
  f.advance(2)
  const anotherParent = await readyItem(f)
  expect(() => insert(f,child(f,anotherParent,'child-grafted'),record(anotherParent,child(f,anotherParent,'child-grafted'),{sourceKey:frozen.sourceKey}))).toThrow(/source key/u)
  expect(f.store.getContinuation(item.id)?.planJson).toBe(frozen.planJson)
})

test('post-event dispatch failure rolls back child, continuation, event and dispatch together', async () => {
  const f = await harness(), parent = await readyItem(f), item = child(f,parent), frozen = record(parent,item)
  sql(f.config.databasePath,db => db.exec("CREATE TRIGGER fail_continuation_dispatch BEFORE INSERT ON work_item_dispatch WHEN NEW.item_id='continuation-child' BEGIN SELECT RAISE(ABORT,'post-event-fault'); END"))
  try {
    expect(() => insert(f,item,frozen)).toThrow(/post-event-fault/u)
    expect(f.store.findItemById(item.id)).toBeUndefined();expect(f.store.events(item.id)).toEqual([]);expect(f.store.getDispatch(item.id)).toBeUndefined();expect(f.store.findContinuationBySourceKey(frozen.sourceKey)).toBeUndefined()
  } finally {sql(f.config.databasePath,db => db.exec('DROP TRIGGER fail_continuation_dispatch'))}
  expect(insert(f,item,frozen).id).toBe(item.id)
})

test('parent owner lineage, same-generation binding, terminal state, real cutoffs and root are enforced', async () => {
  const f = await harness(), parent = await readyItem(f)
  const bad: Partial<WorkItemRecord>[] = [
    {owner:{...parent.owner,principalRecordId:'other'}},{owner:{...parent.owner,principalVersion:parent.owner.principalVersion+1}},
    {scope:{...parent.scope,principalId:'other'}},{scope:{...parent.scope,ownerRouteId:'other'}},
    {scope:{...parent.scope,workspace:'/other'},owner:{...parent.owner,workspace:'/other'}},
    {owner:{...parent.owner,generation:parent.owner.generation-1}},
    {owner:{...parent.owner,bindingVersion:parent.owner.bindingVersion+1}},{originBindingId:'other-binding'},
  ]
  for (const [i,override] of bad.entries()) {const item=child(f,parent,`bad-child-${i}`,override);expect(() => insert(f,item,record(parent,item))).toThrow()}
  for (const cutoff of [{parentReportRevision:999},{parentOutcomeRevision:999},{parentReportRevision:null},{parentOutcomeRevision:null},{rootItemId:'missing-root'}]) {
    const item=child(f,parent,'bad-cutoff');expect(() => insert(f,item,record(parent,item,cutoff))).toThrow()
  }
  f.advance(2)
  const open = await admitted(f), item = child(f,open,'bad-open')
  expect(() => insert(f,item,record(open,item,{parentReportRevision:null,parentOutcomeRevision:null}))).toThrow(/terminal/u)
  const next = child(f,parent,'next-generation',{owner:{...parent.owner,generation:parent.owner.generation+1,bindingVersion:1},originBindingId:'new-generation-binding'})
  expect(insert(f,next,record(parent,next)).id).toBe(next.id)
})

test('nested continuation derives the original root and freezes parent report/outcome cutoffs across later settlement', async () => {
  const f = await harness(), parent = await admitted(f)
  claim(f,parent.id);report(f,parent.id,'progress');report(f,parent.id,'ready')
  const item=child(f,parent), frozen=record(parent,item)
  insert(f,item,frozen)
  expect(f.store.continuationParentReports(item.id).map(row => row.revision)).toEqual([1])
  expect(f.store.continuationParentReports(item.id,1)).toEqual([])
  const outcome = f.store.latestOutcome(parent.id)!
  f.advance(8*86400000)
  f.store.settleOutcome({itemId:parent.id,revision:outcome.revision,evidence:null,reason:'window-expired',degraded:false,expired:true})
  expect(f.store.outcomes(parent.id)).toHaveLength(2)
  expect(f.store.continuationParentOutcomes(item.id).map(row => row.revision)).toEqual([1])
  expect(f.store.continuationParentBrief(item.id)).toBe(parent.brief)
  // Finish child normally before appending a grandchild; parent rows are never rewritten.
  f.ledger.claim({itemId:item.id,runId:'child-run',occurrenceId:'child-run'})
  f.ledger.report({itemId:item.id,runId:'child-run',status:'ready',summary:'done',artifactPaths:[],idempotencyKey:'child-ready'})
  const finished=f.store.findItemById(item.id)!, grandchild=child(f,finished,'grandchild')
  expect(() => insert(f,grandchild,record(finished,grandchild))).toThrow(/root/u)
  insert(f,grandchild,record(finished,grandchild,{rootItemId:parent.id}))
  expect(f.store.getContinuation(grandchild.id)?.rootItemId).toBe(parent.id)
})

test('continuation lease expiry never reclaims a Host one-shot or increments its generation while generic work still recovers', async () => {
  const f = await harness(), parent = await readyItem(f), item=child(f,parent)
  insert(f,item,record(parent,item));claim(f,item.id,'continuation-run')
  f.advance(2)
  const generic = await admitted(f);claim(f,generic.id,'generic-run')
  const before=f.store.getDispatch(item.id), events=f.store.events(item.id).length
  f.advance(f.config.limits.leaseMs+1)
  expect(f.ledger.recover().requeued).toContain(generic.id)
  expect(f.store.findItemById(item.id)?.attempt).toBe(1)
  expect(f.store.getDispatch(item.id)).toEqual(before)
  expect(f.store.events(item.id)).toHaveLength(events)
  expect(() => claim(f,item.id,'replacement-run')).toThrow()
  expect(() => f.store.claim({itemId:item.id,runId:'continuation-run',occurrenceId:'continuation-run',leaseMs:f.config.limits.leaseMs,reclaimExpired:true})).toThrow(/one-shot/u)
  expect(f.store.events(item.id)).toHaveLength(events)
})

test('canonical plan/input digests and byte bounds fail closed, and diagnosis cannot share an admission', async () => {
  const f=await harness(),parent=await readyItem(f),item=child(f,parent),frozen=record(parent,item)
  for (const changed of [
    {...frozen,inputSha256:'0'.repeat(64)}, {...frozen,planDigest:'0'.repeat(64)},
    {...frozen,inputText:'x'.repeat(262145),inputSha256:continuationDigest('x'.repeat(262145))},
    {...frozen,inputText:'\ud800',inputSha256:continuationDigest('\ud800')},
    {...frozen,planJson:'{ "a": 1 }',planDigest:continuationDigest('{ "a": 1 }')},
    {...frozen,planJson:'\ufeff{}',planDigest:continuationDigest('\ufeff{}')},
  ]) expect(() => validateContinuationInput(changed)).toThrow()
  const atLimit = 'x'.repeat(262144)
  expect(validateContinuationInput({...frozen,inputText:atLimit,inputSha256:continuationDigest(atLimit)}).inputBytes).toBe(262144)
  expect(() => f.store.admitItem(item,{kind:'admitted',actor:'admission'},dispatch(item),[],{} as never,frozen)).toThrow(/exclusive/u)
  expect(f.store.findItemById(item.id)).toBeUndefined()
})

test('private admission replay checks source before rate/Policy budget and cannot accept a model-supplied plan', async () => {
  const f=await harness(),parent=await readyItem(f), input=signal({externalId:'continue-source',originBindingId:parent.originBindingId})
  let builds=0
  const sourceDigest='c'.repeat(64),sourceKey=continuationSourceKey(parent.id,sourceDigest)
  const admission=new WorkItemAdmission({config:f.config,store:f.store,ledger:f.ledger,workspace:f.ledger.workspace,policy:f.policy.service,delivery:deliveryPeer(),now:f.now,
    continuationFor: value => value===input ? {parentItemId:parent.id,sourceDigest,sourceKey,create:item => {builds++;return record(parent,item)}} : undefined})
  const first=admission.admit(input), calls=f.policy.requests.length
  f.advance(f.config.admission.dedupWindowMs+1)
  const second=admission.admit(input)
  expect(second.item.id).toBe(first.item.id);expect(second.created).toBe(false)
  expect(builds).toBe(1);expect(f.policy.requests).toHaveLength(calls)
  expect(() => admission.admit({...signal(),continuation:{planJson:'{}'}} as never)).toThrow(/unknown field/u)
})

test('pending/dispatched lookup and owner recall require the explicit continuation worker before pagination', async () => {
  const f=await harness(),parent=await readyItem(f),one=child(f,parent,'child-one'),two=child(f,parent,'child-two')
  insert(f,one,record(parent,one));insert(f,two,record(parent,two,{sourceDigest:'d'.repeat(64),sourceKey:continuationSourceKey(parent.id,'d'.repeat(64))}))
  expect(f.store.listPendingContinuations('continuation-worker',1).map(row => row.item.id)).toEqual(['child-one'])
  expect(f.store.listPendingContinuations('other')).toEqual([])
  expect(f.store.listPendingContinuations('continuation-worker',1,{createdAt:one.createdAt,id:one.id}).map(row=>row.item.id)).toEqual([two.id])
  expect(f.store.listPendingContinuations('continuation-worker',1,{createdAt:two.createdAt,id:two.id})).toEqual([])
  f.store.markDispatchDispatched(one.id,'occ-one');f.store.markDispatchDispatched(two.id,'occ-two')
  expect(f.store.latestContinuationDispatch('continuation-worker')?.item.id).toBe(two.id)
  const owner={principalId:parent.scope.principalId,principalRecordId:parent.owner.principalRecordId,principalVersion:parent.owner.principalVersion,workspace:parent.scope.workspace,preset:parent.scope.preset,ownerRouteId:parent.scope.ownerRouteId,workerAutomationId:parent.workerAutomationId,generation:parent.owner.generation,bindingVersion:parent.owner.bindingVersion}
  expect(f.store.listOwnerItems(owner,undefined,1).map(item => item.id)).toEqual([parent.id])
  expect(f.store.listOwnerItems({...owner,continuationAutomationId:'continuation-worker'},undefined,1).map(item => item.id)).toEqual([one.id])
  expect(f.store.listOwnerItems({...owner,continuationAutomationId:'other'},undefined,1).map(item => item.id)).toEqual([parent.id])
  expect(f.store.continuationDispatchUncertain('continuation-worker')).toBe(false)
  f.store.markDispatchUnknown(two.id)
  expect(f.store.continuationDispatchUncertain('continuation-worker')).toBe(true)
  expect(f.store.continuationDispatchUncertain('other')).toBe(false)
})


test('a malformed private continuation builder cannot enqueue an unsigned ordinary child', async () => {
  const f=await harness(),parent=await readyItem(f),input=signal({externalId:'bad-private-builder',originBindingId:parent.originBindingId}),sourceDigest='c'.repeat(64)
  const admission=new WorkItemAdmission({config:f.config,store:f.store,ledger:f.ledger,workspace:f.ledger.workspace,policy:f.policy.service,delivery:deliveryPeer(),now:f.now,
    continuationFor:()=>({parentItemId:parent.id,sourceDigest,sourceKey:continuationSourceKey(parent.id,sourceDigest),create:()=>undefined as never})})
  expect(() => admission.admit(input)).toThrow(/did not freeze a record/u)
  expect(f.store.stats().items).toBe(1)
})

test('a reportless withdrawn parent freezes an empty report history without turning null into an unlimited reader', async () => {
  const f=await harness(), input=signal(), admittedParent=f.admission.admit(input).item
  f.admission.withdraw(input)
  const parent=f.store.findItemById(admittedParent.id)!,item=child(f,parent)
  expect(parent.state).toBe('dropped');expect(f.store.reports(parent.id)).toEqual([])
  insert(f,item,record(parent,item,{parentReportRevision:null}))
  expect(f.store.getContinuation(item.id)?.parentReportRevision).toBeNull()
  expect(f.store.continuationParentReports(item.id)).toEqual([])
  expect(f.store.continuationParentOutcomes(item.id).map(row=>row.revision)).toEqual([1])
})


test('owner-continuation is reserved for its private mint even when the public kind allowlist includes it', async () => {
  const f=await harness(),parent=await readyItem(f),input=signal({kind:'owner-continuation',externalId:'reserved-continuation',originBindingId:parent.originBindingId})
  const config={...f.config,admission:{...f.config.admission,allowedKinds:[...f.config.admission.allowedKinds,'owner-continuation']}}
  const dependencies={config,store:f.store,ledger:f.ledger,workspace:f.ledger.workspace,policy:f.policy.service,delivery:deliveryPeer(),now:f.now}
  const publicAdmission=new WorkItemAdmission(dependencies),before=f.store.stats(),events=f.store.events(parent.id),policyCalls=f.policy.requests.length
  let rejected: unknown
  try {publicAdmission.admit(input)} catch (error) {rejected=error}
  expect(rejected).toMatchObject({code:'invalid-input',message:expect.stringContaining('private continuation mint')})
  expect(f.store.stats()).toEqual(before)
  expect(f.store.events(parent.id)).toEqual(events)
  expect(f.policy.requests).toHaveLength(policyCalls)
  const sourceDigest='c'.repeat(64),sourceKey=continuationSourceKey(parent.id,sourceDigest)
  expect(f.store.findContinuationBySourceKey(sourceKey)).toBeUndefined()
  const privateAdmission=new WorkItemAdmission({...dependencies,continuationFor:value=>value===input
    ? {parentItemId:parent.id,sourceDigest,sourceKey,create:item=>record(parent,item)} : undefined})
  const result=privateAdmission.admit(input)
  expect(result.created).toBe(true);expect(result.item.kind).toBe('owner-continuation')
  expect(f.store.getContinuation(result.item.id)?.parentItemId).toBe(parent.id)
  expect(result.dispatch.state).toBe('pending')
  expect(publicAdmission.admit(signal({kind:'review'})).created).toBe(true)
})


test('a real frozen continuation rejects hidden raw TEXT tails before wake while preserving NUL body data', async () => {
  // Real controller.prepare/create-plan -> SQLite -> controller.validateWake.
  // Host and owner receipts are explicit peers; this never executes a model.
  const f=await harness(),clock=vi.spyOn(Date,'now').mockImplementation(f.now)
  let runtime: WorkItemContinuation | undefined
  try {
    const parent=await admitted(f,{brief:'parent\0brief😀'})
    claim(f,parent.id)
    f.ledger.report({itemId:parent.id,runId:`occ-${parent.id}`,status:'ready',summary:'parent\0report😀',artifactPaths:[],idempotencyKey:'sealed-parent'})
    const config=normalizeConfig({enabled:true,mode:'active',databasePath:f.config.databasePath,workRoot:f.config.workRoot,intakeSourceId:f.config.intakeSourceId,workerAutomationId:f.config.workerAutomationId!,scope:f.config.scope!,ownerRecall:{enabled:true},
      admission:{...f.config.admission,allowedKinds:[...f.config.admission.allowedKinds,'owner-continuation']},ownerContinuation:{enabled:true,automationId:'continuation-worker',allowedTools:['work_item_claim','work_item_report','work_item_read_context','execute'],
        budgetId:'continuation-budget',budgetAmount:1,maxModelCalls:8,maxToolCalls:20,maxOutputTokens:256,timeoutMs:15000,expiresAt:f.now()+3600000}},f.now())
    const owner=receipt({authorityId:config.scope!.ownerRouteId,principalId:config.scope!.principalId,workspace:config.scope!.workspace,agentPreset:config.scope!.preset})
    const schemas=config.ownerContinuation!.allowedTools.map(name=>({name,description:name,parameters:{type:'object',additionalProperties:false}}))
    let definition: HostAutomationDefinition | undefined
    const production: ContinuationProductionProof={protocol:'assistant-automations/production-occurrence/v1',automationId:parent.workerAutomationId,occurrenceId:`occ-${parent.id}`,taskId:'task-parent',attemptId:'attempt-parent',runId:'run-parent',executionMode:'production',status:'succeeded',completedAt:f.now(),quiescent:true,budgetSettlementState:'finalized',
      immutableContext:{state:'verified',definitionHash:'a'.repeat(64),definitionVersion:1,scope:{workspace:parent.scope.workspace,agentPreset:parent.scope.preset}}}
    const automations={hostAgentAuthorizationVersion:()=>1,runAgentForHostExecution:async()=>{throw new Error('no model in byte-seal component test')},registerHostExecutor:()=>()=>{},
      reconcileSystem:(input:{definition:HostAutomationDefinition})=>{definition=input.definition},
      inspectSystemOwned:()=>{if(!definition) throw Object.assign(new Error('not found'),{code:'not-found'});return {owner:CONTINUATION_OWNER,automationId:'continuation-worker',automationStatus:'active',definitionHash:continuationDefinitionHash(definition),definitionVersion:1}},
      inspectSystemOwnedActivation:()=>{if(!definition) throw new Error('definition unavailable');return {definitionHash:continuationDefinitionHash(definition),activationNonce:definition.execution.activationNonce,ownerRouteId:config.scope!.ownerRouteId}},
      inspectProductionOccurrence:()=>production}
    const context={get:(name:string)=>({assistantAutomations:automations,assistantDelivery:{validateOwnerRoute:()=>owner},assistantPolicy:f.policy.service})[name as 'assistantAutomations'],tools:{schemas:()=>schemas}} as unknown as Context
    runtime=new WorkItemContinuation(context,config,f.store,{assertOwner:()=>owner,assertMandate:()=>{},wake:()=>false})
    runtime.start()
    const source={sourceDigest:'f'.repeat(64),inputText:'original\0input😀',modelSelection:{provider:'human-provider',model:'human-model',reasoningEffort:'high'}}
    const mint=runtime.prepare(parent.id,source,()=>{})
    const item=child(f,parent,'real-sealed-child',{maxAttempts:1})
    insert(f,item,mint.create(item))
    expect(runtime.validateWake(f.store.findItemById(item.id)!)).toBe(true)
    const columns=['workspace','agent_preset','principal_id','principal_record_id','owner_route_id','external_id','origin_binding_id','source_id','kind','worker_automation_id','dedup_key','work_dir','authority_basis']
    for(const column of columns) {
      let original!: Buffer
      sql(f.config.databasePath,db=>{original=Buffer.from((db.prepare(`SELECT CAST(${column} AS BLOB) AS bytes FROM work_item WHERE id=?`).get(item.id) as {bytes:Uint8Array}).bytes)
        db.prepare(`UPDATE work_item SET ${column}=CAST(? AS TEXT) WHERE id=?`).run(Buffer.concat([original,Buffer.from('\0foreign')]),item.id)})
      try {
        const projected=f.store.findItemById(item.id)!
        // On 24.7 the basis is unchanged; the production currentPlan must still refuse.
        if(process.versions.node==='24.7.0') expect(continuationItemBasis(projected)).toEqual(continuationItemBasis(item))
        expect(runtime.validateWake(projected),column).toBe(false)
      } finally {sql(f.config.databasePath,db=>db.prepare(`UPDATE work_item SET ${column}=CAST(? AS TEXT) WHERE id=?`).run(original,item.id))}
      expect(runtime.validateWake(f.store.findItemById(item.id)!)).toBe(true)
    }
    sql(f.config.databasePath,db=>db.prepare('UPDATE work_item SET title=?,brief=?,acceptance_ref=? WHERE id=?').run('title\0tail','brief\0tail','reference\0tail',item.id))
    const formattedAuthority=JSON.stringify(Object.fromEntries(Object.entries(item.authority!).reverse()),null,2)
    sql(f.config.databasePath,db=>db.prepare('UPDATE work_item SET authority_basis=? WHERE id=?').run(formattedAuthority,item.id))
    expect(runtime.validateWake(f.store.findItemById(item.id)!)).toBe(true)
    expect(f.store.getContinuation(item.id)?.inputText).toBe(source.inputText)
    expect(f.store.continuationParentBrief(item.id)).toBe('parent\0brief😀')
    expect(f.store.continuationParentReports(item.id)[0]?.summary).toBe('parent\0report😀')
  } finally {runtime?.close();clock.mockRestore()}
})
