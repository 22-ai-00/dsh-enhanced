import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import { query, workItemLearningFixture } from './work-item-feedback.fixture.ts'

type Fixture=Awaited<ReturnType<typeof workItemLearningFixture>>
async function feedbackSource(f:Fixture) {
  const itemId=await f.produce();await f.acceptReports()
  const report=query(join(f.root,'items.sqlite'),`SELECT delivery_id FROM work_item_report WHERE item_id='${itemId}'`)[0]!
  const outbox=f.operator!.getOutbox(String(report.delivery_id))!
  expect(outbox).toMatchObject({status:'accepted',providerMessageId:expect.any(String)})
  const before={requests:f.supplier.requests.length,runs:f.snapshot().runs,budget:f.snapshot().budget}
  const feedback=await f.reply(outbox.providerMessageId!,'还是不行','memory-owner-result')
  await vi.waitFor(async()=>{
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    expect(f.ctx.assistantEvaluation.getTrustedWorkItemLearningProjection({scope:f.ctx.assistantEvaluation.createHostScope({workspace:f.workspace,preset:'primary'}),itemId})).toMatchObject({projection:{subjectKind:'work-item',subjectRef:itemId},objective:{status:'not-achieved'}})
  },{timeout:10000})
  expect({requests:f.supplier.requests.length,runs:f.snapshot().runs,budget:f.snapshot().budget}).toEqual(before)
  expect(f.operator!.getInbox(feedback.inboxId)?.status).toBe('processed')
  expect(query(join(f.root,'delivery.sqlite'),`SELECT * FROM delivery_foreground_executions WHERE inbox_id='${feedback.inboxId}'`)).toEqual([])
  return {itemId,providerMessageId:outbox.providerMessageId!,feedback}
}
async function adopted(f:Fixture) {
  await vi.waitFor(async()=>{
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    expect(f.ctx.assistantMemoryLearning.health(),JSON.stringify(f.warnings)).toMatchObject({counts:{adopted:1}})
  },{timeout:15000})
}
function paidCounts(f:Fixture) {
  const jobs=query(join(f.root,'learning.sqlite'),'SELECT id FROM jobs').map(row=>`background:${String(row.id)}`)
  const reservations=query(join(f.root,'policy.sqlite'),'SELECT id,scope,amount FROM budget_reservations ORDER BY id').filter(row=>jobs.includes(String(row.scope)))
  return {reservations,learning:query(join(f.root,'learning.sqlite'),'SELECT authority_id,config_digest,max_extractions,consumed FROM grant_record'),
    reviews:query(join(f.root,'verifier.sqlite.memory-reviews'),'SELECT authority,digest,max,used FROM grants'),
    adoptions:query(join(f.root,'memory.sqlite'),"SELECT authority_id,grant_json,grant_digest,used_mutations FROM memory_learning_adoptions WHERE row_kind='grant'")}
}
async function revise(f:Fixture,providerMessageId:string,text:string,eventId:string) {
  return f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId,occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text,metadata:{replyToProviderMessageId:providerMessageId}})
}

// These are real native component and durable-ledger tests. The finite local
// supplier implements deterministic extraction/review checks; it does not prove
// semantic model quality, real-provider behavior, or subsequent task improvement.
describe('work-item owner failure into independently reviewed native memory',()=>{
  test('random actual report and owner outcome drive zero-tool extraction, a separate review and bounded Memory adoption',async()=>{
    const f=await workItemLearningFixture(),source=await feedbackSource(f)
    await f.mountLearning();await adopted(f)
    const jobs=query(join(f.root,'learning.sqlite'),'SELECT * FROM jobs')
    expect(jobs).toHaveLength(1)
    const job=jobs[0]!,intent=JSON.parse(String(job.intent_json)),request=JSON.parse(String(job.request_json))
    expect(intent).toMatchObject({sourceKind:'work-item',subject:`work-item:${source.itemId}`,kind:'experience',itemId:source.itemId,canonical:{objectiveStatus:'not-achieved'}})
    expect(request).toMatchObject({protocol:'memory-learning-review/v2',source:{protocol:'memory-learning-source/work-item/v1',itemId:source.itemId},mutation:{op:'add',entry:{kind:'experience',content:f.supplier.memoryContent}},evidenceQuote:'还是不行'})
    const extraction=f.supplier.requests.filter(call=>String(call.sessionId).startsWith('memory-extract-'))
    const review=f.supplier.requests.filter(call=>String(call.sessionId).startsWith('memory-review-'))
    expect(extraction).toHaveLength(1);expect(review).toHaveLength(1)
    expect(String(review[0]!.sessionId)).not.toBe(String(extraction[0]!.sessionId))
    expect(request.extractionSessionId).toBe(String(extraction[0]!.sessionId))
    for(const call of [...extraction,...review]) {expect(call).toMatchObject({provider:'local',model:'scripted'});expect(call.tools??[]).toEqual([])}
    expect(query(join(f.root,'verifier.sqlite.memory-reviews'),'SELECT state FROM reviews')).toEqual([{state:'approved'}])
    const hits=await f.queryMemory()
    expect(hits).toHaveLength(1);expect(hits[0]!.record).toMatchObject({kind:'experience',content:f.supplier.memoryContent})
    expect(paidCounts(f)).toMatchObject({learning:[{consumed:1}],reviews:[{used:1}],adoptions:[{used_mutations:1}]})
    expect(paidCounts(f).reservations).toHaveLength(1)
  },15000)

  test('owner correction then withdrawal hides old experience immediately and across cold Memory stack reopening',async()=>{
    const f=await workItemLearningFixture(),source=await feedbackSource(f)
    await f.mountLearning();await adopted(f)
    expect(await f.queryMemory()).toHaveLength(1)
    const paid=paidCounts(f),calls=f.supplier.requests.filter(call=>/^memory-(extract|review)-/u.test(String(call.sessionId))).length
    await revise(f,source.providerMessageId,'/feedback correct 1 not-achieved achieved','correct-memory-source')
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    expect(f.ctx.assistantEvaluation.queryTasks({scope:{workspace:f.workspace,preset:'primary'}}).find(task=>task.projection.subjectKind==='work-item'&&task.projection.subjectRef===source.itemId)?.objectiveStatus).toBe('achieved')
    expect(await f.queryMemory()).toEqual([])
    await f.remountMemoryStack()
    expect(await f.queryMemory()).toEqual([])
    await revise(f,source.providerMessageId,'/feedback withdraw 2 achieved','withdraw-memory-source')
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    expect(f.ctx.assistantEvaluation.queryTasks({scope:{workspace:f.workspace,preset:'primary'}}).find(task=>task.projection.subjectKind==='work-item'&&task.projection.subjectRef===source.itemId)?.objectiveStatus).toBe('unknown')
    expect(await f.queryMemory()).toEqual([])
    await f.remountMemoryStack();expect(await f.queryMemory()).toEqual([])
    expect(paidCounts(f)).toEqual(paid);expect(f.supplier.requests.filter(call=>/^memory-(extract|review)-/u.test(String(call.sessionId)))).toHaveLength(calls)
  },15000)

  test('real adoption followed by lost ACK and a duplicate owner message recovers the same operation without another extraction or review',async()=>{
    const f=await workItemLearningFixture(),source=await feedbackSource(f)
    const original=PersonalMemoryService.prototype.adoptReviewedLearning
    let lost=false,recoverReceipts=false
    const lookup=PersonalMemoryService.prototype.lookupLearningAdoption
    vi.spyOn(PersonalMemoryService.prototype,'lookupLearningAdoption').mockImplementation(function(this:PersonalMemoryService,input){if(!recoverReceipts)throw new Error('fixture durable adoption receipt temporarily unavailable');return lookup.call(this,input)})
    vi.spyOn(PersonalMemoryService.prototype,'adoptReviewedLearning').mockImplementation(function(this:PersonalMemoryService,input){
      const receipt=original.call(this,input)
      if(!lost){lost=true;throw new Error('fixture durable Memory adoption ACK lost')}
      return receipt
    })
    await f.mountLearning()
    await vi.waitFor(async()=>{await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle();expect(lost).toBe(true)},{timeout:30000})
    expect(query(join(f.root,'learning.sqlite'),'SELECT state FROM jobs')).toEqual([{state:'unknown'}])
    const before=paidCounts(f),calls=f.supplier.requests.filter(call=>/^memory-(extract|review)-/u.test(String(call.sessionId))).length
    const operation=query(join(f.root,'memory.sqlite'),"SELECT operation_id FROM memory_learning_adoptions WHERE row_kind='operation'")
    expect(operation).toHaveLength(1)
    await f.stopLearning();recoverReceipts=true;await f.remountMemoryStack();await adopted(f)
    expect(query(join(f.root,'memory.sqlite'),"SELECT operation_id FROM memory_learning_adoptions WHERE row_kind='operation'")).toEqual(operation)
    expect(await f.ctx.assistantDelivery.acceptInbound(f.operator!.getInbox(source.feedback.inboxId)!.envelope)).toMatchObject({duplicate:true,status:'processed'})
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    expect(paidCounts(f)).toEqual(before);expect(f.supplier.requests.filter(call=>/^memory-(extract|review)-/u.test(String(call.sessionId)))).toHaveLength(calls)
    expect(await f.queryMemory()).toHaveLength(1)
  },120000)

  test('old independent review and adoption grants fail closed before paid work-item extraction',async()=>{
    const f=await workItemLearningFixture();await feedbackSource(f)
    await f.mountLearning({workItemGrants:false})
    const initial=f.supplier.requests.length
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    expect(f.supplier.requests).toHaveLength(initial)
    expect(f.supplier.requests.filter(call=>/^memory-(extract|review)-/u.test(String(call.sessionId)))).toEqual([])
    expect(query(join(f.root,'learning.sqlite'),'SELECT consumed FROM grant_record')).toEqual([{consumed:0}])
    expect(query(join(f.root,'memory.sqlite'),"SELECT operation_id FROM memory_learning_adoptions WHERE row_kind='operation'")).toEqual([])
  },15000)
})
