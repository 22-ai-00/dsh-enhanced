import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import { continuationRows, feedbackFixture, query } from './native-owner-feedback.fixture.ts'

type Fixture=Awaited<ReturnType<typeof feedbackFixture>>
async function report(f:Fixture,item:string) {
  await f.acceptReports()
  const id=String(query(join(f.root,'items.sqlite'),`SELECT delivery_id FROM work_item_report WHERE item_id='${item}'`)[0]!.delivery_id)
  const outbox=f.operator!.getOutbox(id)!
  expect(outbox).toMatchObject({status:'accepted',providerMessageId:expect.any(String)})
  expect(f.sent.filter(row=>row.providerMessageId===outbox.providerMessageId)).toHaveLength(1)
  return outbox.providerMessageId!
}
function projection(f:Fixture,itemId:string) {
  return f.ctx.assistantEvaluation.getTrustedWorkItemLearningProjection({scope:f.ctx.assistantEvaluation.createHostScope({workspace:f.root,preset:'primary'}),itemId})
}
function baseline(f:Fixture) {return {requests:f.supplier.requests.length,runs:f.snapshot().runs,budget:f.snapshot().budget,continuations:continuationRows(f)}}
function noExecution(f:Fixture,before:ReturnType<typeof baseline>,inboxId:string) {
  expect(baseline(f)).toEqual(before)
  expect(f.operator!.getInbox(inboxId)?.status).toBe('processed')
  expect(query(join(f.root,'delivery.sqlite'),`SELECT * FROM delivery_foreground_executions WHERE inbox_id='${inboxId}'`)).toEqual([])
}
async function waitObjective(f:Fixture,item:string,status:string,ownerVersion:number) {
  await vi.waitFor(async()=>{
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    const receipt=projection(f,item)
    expect(receipt).toMatchObject({projection:{subjectKind:'work-item',subjectRef:item}})
    const task=f.ctx.assistantEvaluation.queryTasks({scope:{workspace:f.root,preset:'primary'}}).find(task=>task.projection.subjectKind==='work-item'&&task.projection.subjectRef===item)
    expect(task?.objectiveStatus).toBe(status)
    expect(query(join(f.root,'evaluation.sqlite'),'SELECT version FROM evaluation_owner_revisions ORDER BY version DESC LIMIT 1')).toEqual([{version:ownerVersion}])
  },{timeout:10000})
  return projection(f,item)!
}
async function learning(f:Fixture,outcomeId:string) {
  return f.ctx.assistantDelivery.inspectOwnerWorkItemLearningTask({...f.scope,outcomeId})
}
function sql(f:Fixture,statement:string) {const db=new DatabaseSync(join(f.root,'delivery.sqlite'));try{db.exec(statement)}finally{db.close()}}
async function command(f:Fixture,providerMessageId:string,text:string,eventId:string) {
  return f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId,occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text,metadata:{replyToProviderMessageId:providerMessageId}})
}

describe('native WorkItems authenticated owner report feedback',()=>{
  test.each([['问题解决了','achieved'],['还是不行','not-achieved']] as const)('real accepted report + %s records one owner vote without execution',async(text,status)=>{
    const f=await feedbackFixture(),parent=await f.produce(),provider=await report(f,parent),before=baseline(f)
    const originalOwner=f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
    const sealed=query(join(f.root,'items.sqlite'),"SELECT detail FROM work_item_event WHERE sequence=1")
    const definitions=query(join(f.root,'automations.sqlite'),'SELECT * FROM automation_definitions ORDER BY id')
    const reconciliations=query(join(f.root,'automations.sqlite'),'SELECT * FROM automation_changes ORDER BY idempotency_key')
    // This one case simulates passage beyond the unchanged finite authorization.
    // Native production/SQLite/Policy are real; no claim of a live hour-long wait.
    const expiry=f.workConfig.scope?.expiresAt
    if(typeof expiry!=='number') throw new Error('fixture requires a finite execution expiry')
    const realNow=Date.now.bind(Date),offset=expiry+1-realNow()
    const clock=status==='achieved'?vi.spyOn(Date,'now').mockImplementation(()=>realNow()+offset):undefined
    try {
      if(clock) await f.reopen()
      // The exact owner route and label-only Policy rule have no time expiry;
      // only the three unchanged execution authorizations have elapsed.
      expect(f.ctx.assistantDelivery.validateOwnerRoute(f.scope)).toMatchObject({principalRecordId:originalOwner.principalRecordId,principalVersion:originalOwner.principalVersion,generation:originalOwner.generation})
      expect(f.ctx.assistantPolicy.authorize({subject:{kind:'external',id:f.scope.principalId},action:'feedback-work-items',resource:{kind:'automation',id:'continuation-worker'},context:{initiator:'external'}}).effect).toBe('allow')
    const target=JSON.parse(String(query(join(f.root,'delivery.sqlite'),`SELECT target_json FROM delivery_work_item_reports WHERE json_extract(target_json,'$.itemId')='${parent}'`)[0]!.target_json))
    const capability=f.ctx.assistantWorkItems.issueOwnerWorkItemFeedbackTarget({itemId:parent,reportRevision:target.reportRevision,reportDigest:target.reportDigest})
    expect(capability,JSON.stringify(f.ctx.assistantWorkItems.health())).toBeDefined()
    expect(f.ctx.assistantWorkItems.resolveOwnerWorkItemFeedbackTarget(capability)).toMatchObject({itemId:parent,production:{runId:String(before.runs[0]!.id),quiescent:true,budgetSettlementState:'finalized'}})
    expect(projection(f,parent)).toBeUndefined()
    // Feedback authorization grants neither external execution nor reply continuation.
    for(const action of ['execute','continue-work-items-from-reply']) expect(f.ctx.assistantPolicy.authorize({subject:{kind:'external',id:f.scope.principalId},action,resource:{kind:'automation',id:'continuation-worker'},context:{initiator:'external'}}).effect).toBe('deny')
    const source=await f.reply(provider,text,'natural-result')
    const receipt=await waitObjective(f,parent,status,1)
    noExecution(f,before,source.inboxId)
    const task=await learning(f,receipt.projection.evidenceOutcomeId!)
    expect(task).toMatchObject({protocol:'assistant-delivery/owner-work-item-learning/v1',judgement:'owner-feedback',ownerRevision:{version:1,action:'initial'},proofIdentity:{itemId:parent,production:{executionStatus:'succeeded',quiescent:true,budgetSettlementState:'finalized'},supplier:{provider:'local',model:'scripted'}},presentation:{feedback:{inboxId:source.inboxId,text}}})
    expect(task?.owner).toMatchObject({principalId:f.scope.principalId,principalRecordId:f.ctx.assistantDelivery.validateOwnerRoute(f.scope).principalRecordId})
    expect(task?.proofIdentity.production).toMatchObject({automationId:'diagnosis-worker',runId:String(before.runs[0]!.id)})
    expect(task?.sourceDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.execution).toMatchObject({status:'succeeded'})
    expect(receipt.objective!.source.kind).toBe('user-feedback')
    expect(receipt.objective!.evidence).toEqual(expect.arrayContaining([expect.objectContaining({kind:'work-item-owner-result'}),expect.objectContaining({kind:'work-item-production-proof'})]))
    expect(query(join(f.root,'evaluation.sqlite'),'SELECT * FROM evaluation_owner_revisions')).toHaveLength(1)
    expect(query(join(f.root,'items.sqlite'),"SELECT detail FROM work_item_event WHERE sequence=1")).toEqual(sealed)
    expect(query(join(f.root,'automations.sqlite'),'SELECT * FROM automation_definitions ORDER BY id')).toEqual(definitions)
    expect(query(join(f.root,'automations.sqlite'),'SELECT * FROM automation_changes ORDER BY idempotency_key')).toEqual(reconciliations)
    } finally {clock?.mockRestore()}
  },100000)

  test('correct, duplicate and cold withdrawal preserve one canonical task and invalidate old learning reads',async()=>{
    const f=await feedbackFixture(),parent=await f.produce(),provider=await report(f,parent),before=baseline(f)
    await f.reply(provider,'问题解决了','initial-vote');const first=await waitObjective(f,parent,'achieved',1)
    const corrected=await command(f,provider,'/feedback correct 1 achieved not-achieved','correct-vote')
    const second=await waitObjective(f,parent,'not-achieved',2)
    expect(await learning(f,first.projection.evidenceOutcomeId!)).toBeUndefined()
    noExecution(f,before,corrected.inboxId)
    await f.reopen()
    const old=f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
    await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'feedback-new-session',occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text:'/new'})
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    expect(f.ctx.assistantDelivery.validateOwnerRoute(f.scope).generation).toBeGreaterThan(old.generation)
    const withdrawn=await command(f,provider,'/feedback withdraw 2 not-achieved','withdraw-vote')
    const final=await waitObjective(f,parent,'unknown',3)
    expect(final.projection.disposition).toBe('retract')
    expect(await learning(f,second.projection.evidenceOutcomeId!)).toBeUndefined()
    const duplicate=f.operator!.getInbox(withdrawn.inboxId)!.envelope
    expect(await f.ctx.assistantDelivery.acceptInbound(duplicate)).toMatchObject({duplicate:true,inboxId:withdrawn.inboxId,status:'processed'})
    await f.ctx.assistantDelivery.tick()
    expect(projection(f,parent)?.projection).toEqual(final.projection)
    expect(query(join(f.root,'evaluation.sqlite'),'SELECT * FROM evaluation_owner_revisions')).toHaveLength(3)
    noExecution(f,before,withdrawn.inboxId)
  },100000)

  test('replying to original P after C1 exists evaluates P rather than mutable stream head',async()=>{
    const f=await feedbackFixture({replyEnabled:true}),parent=await f.produce(),provider=await report(f,parent)
    await f.reply(provider,'继续检查这个任务的新要求。','continue-before-feedback');await f.waitRuns(2)
    const child=String(continuationRows(f)[0]!.item_id),before=baseline(f)
    const result=await f.reply(provider,'问题解决了','vote-original')
    await waitObjective(f,parent,'achieved',1)
    expect(projection(f,child)).toBeUndefined();noExecution(f,before,result.inboxId)
  },100000)

  test('feedback waits for real parent native quiescence without asserting an early outcome',async()=>{
    const f=await feedbackFixture({holdSummary:true}),producing=f.produce()
    try {
      const parent=await f.waitParentReport(),provider=await report(f,parent),before=baseline(f)
      const result=await f.reply(provider,'问题解决了','pending-vote')
      await f.ctx.assistantDelivery.tick()
      expect(projection(f,parent)).toBeUndefined()
      expect(query(join(f.root,'delivery.sqlite'),'SELECT state FROM delivery_work_item_feedback')).toEqual([{state:'pending'}])
      noExecution(f,before,result.inboxId)
      f.releaseSummary();await producing
      await waitObjective(f,parent,'achieved',1)
      expect(continuationRows(f)).toEqual([])
    } finally {f.releaseSummary();await producing}
  },100000)

  test('a lost ACK after real Evaluation append recovers on cold remount without another owner vote',async()=>{
    const f=await feedbackFixture(),parent=await f.produce(),provider=await report(f,parent),before=baseline(f)
    // Real SQLite fault after canonical append, rather than a fabricated outcome.
    sql(f,"CREATE TRIGGER fixture_lost_feedback_ack BEFORE UPDATE OF state ON delivery_work_item_feedback WHEN NEW.state='recorded' BEGIN SELECT RAISE(ABORT,'fixture lost feedback ACK'); END;")
    const result=await f.reply(provider,'问题解决了','lost-ack-vote')
    const original=await waitObjective(f,parent,'achieved',1)
    const frozen=query(join(f.root,'delivery.sqlite'),'SELECT operation_id,state FROM delivery_work_item_feedback')[0]!
    expect(frozen.state).toBe('frozen')
    const operation=JSON.parse(String(query(join(f.root,'evaluation.sqlite'),'SELECT command_json FROM evaluation_owner_revisions')[0]!.command_json))
    expect(operation.operationId).toBe(frozen.operation_id)
    sql(f,'DROP TRIGGER fixture_lost_feedback_ack')
    await f.reopen();await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    expect(query(join(f.root,'delivery.sqlite'),'SELECT state FROM delivery_work_item_feedback')).toEqual([{state:'recorded'}])
    expect(query(join(f.root,'evaluation.sqlite'),'SELECT * FROM evaluation_owner_revisions')).toHaveLength(1)
    expect(projection(f,parent)?.projection).toEqual(original.projection)
    expect(query(join(f.root,'delivery.sqlite'),'SELECT operation_id FROM delivery_work_item_feedback')).toEqual([{operation_id:frozen.operation_id}]);noExecution(f,before,result.inboxId)
  },100000)

  test('wrong owner and fabricated provider target cannot vote; old opaque capability expires on component replacement',async()=>{
    const f=await feedbackFixture(),parent=await f.produce(),provider=await report(f,parent),before=baseline(f)
    const stranger={...f.principal,user:'stranger'},pairing=f.ctx.assistantDelivery.issuePairing('test',stranger)
    f.ctx.assistantDelivery.confirmPairing({challengeId:pairing.challenge.id,principal:stranger,code:pairing.code})
    const foreign=await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'foreign-vote',occurredAt:Date.now(),principal:stranger,conversation:f.conversation,kind:'text',text:'问题解决了',metadata:{replyToProviderMessageId:provider}})
    expect(foreign.status).toBe('dead_letter')
    expect(f.operator!.getInbox(foreign.inboxId)?.failureCode).toBe('binding-principal-mismatch')
    const forged=await f.reply('made-up-provider-target','问题解决了','forged-vote')
    expect(forged.status).toBe('queued');expect(projection(f,parent)).toBeUndefined()
    const target=JSON.parse(String(query(join(f.root,'delivery.sqlite'),'SELECT target_json FROM delivery_work_item_reports')[0]!.target_json))
    const cap=f.ctx.assistantWorkItems.issueOwnerWorkItemFeedbackTarget({itemId:parent,reportRevision:target.reportRevision,reportDigest:target.reportDigest})
    expect(cap).toBeDefined();expect(f.ctx.assistantWorkItems.resolveOwnerWorkItemFeedbackTarget(cap)).toBeDefined()
    await f.restart()
    expect(f.ctx.assistantWorkItems.resolveOwnerWorkItemFeedbackTarget(cap)).toBeUndefined()
    expect(baseline(f)).toEqual(before)
  },100000)
})
