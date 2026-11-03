import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { continuationRows, expectPages, expectUnverifiedObjective, query, replyFixture, reportText } from './native-owner-reply.fixture.ts'

// Real Cordis/Loader/native AgentLoop/JSONL/Policy/Delivery/Automations/WorkItems.
// The adapter is a local provider-acceptance transport and the supplier is finite
// scripted code, not an external IM provider or a demonstration of intelligence.
async function acceptedReport(f: Awaited<ReturnType<typeof replyFixture>>, item: string) {
  await f.acceptReports()
  const report=query(join(f.root,'items.sqlite'),`SELECT delivery_id FROM work_item_report WHERE item_id='${item}'`)[0]!
  const outbox=f.operator!.getOutbox(String(report.delivery_id))!
  expect(outbox.status).toBe('accepted');expect(outbox.providerMessageId).toBeTruthy()
  expect(f.sent.filter(sent=>sent.providerMessageId===outbox.providerMessageId)).toHaveLength(1)
  return outbox.providerMessageId!
}
function noForeground(f: Awaited<ReturnType<typeof replyFixture>>, inboxId:string) {
  expect(f.operator!.getInbox(inboxId)?.status).toBe('processed')
  expect(query(join(f.root,'delivery.sqlite'),`SELECT * FROM delivery_foreground_executions WHERE inbox_id='${inboxId}'`)).toEqual([])
}

describe('native owner report reply continuation',()=>{
  test('two real replies to original accepted report follow the stream head, retain source, and inherit frozen supplier',async()=>{
    const f=await replyFixture(),parent=await f.produce(),providerId=await acceptedReport(f,parent)
    const foregroundRequests=f.supplier.requests.filter(r=>!String(r.sessionId).startsWith('automation-')).length
    const firstText='继续第一轮🧭：保留原报告再检查新的约束。'
    const first=await f.reply(providerId,firstText,'reply-one')
    await f.ctx.assistantDelivery.tick();const runs=await f.waitRuns(2)
    const firstRow=continuationRows(f)[0]!,child=String(firstRow.item_id)
    expectPages(f,child,parent,parent,firstText);expectUnverifiedObjective(f,runs[1]!,child)
    noForeground(f,first.inboxId)
    // Change current preset route; reply continuation must inherit the sealed
    // parent execution supplier rather than consult this mutable configuration.
    f.deliveryConfig.agentProvider='replacement';f.deliveryConfig.agentModel='changed-current-default';await f.reopen()
    const secondText='继续第二轮🙂：按第一轮的新报告处理，仍回复最初消息。'
    const second=await f.reply(providerId,secondText,'reply-two')
    await f.ctx.assistantDelivery.tick();const finalRuns=await f.waitRuns(3),links=continuationRows(f)
    expect(links).toHaveLength(2)
    expect(links[1]).toMatchObject({parent_item_id:child,root_item_id:parent,input_text:secondText})
    expectPages(f,String(links[1]!.item_id),child,parent,secondText,'Continued from current owner input and bounded historical pages.')
    noForeground(f,second.inboxId)
    for(const [index,row] of links.entries()) {
      const plan=JSON.parse(String(row.plan_json))
      expect(plan.protocol).toBe('assistant-work-items/owner-continuation-plan/v2')
      expect(plan.authorization.modelOrigin).toBe('inherited-parent-execution')
      expect(plan.source.origin.reply.target).toMatchObject({itemId:parent,providerMessageId:providerId,streamId:parent})
      const source=f.ctx.assistantDelivery.readWorkItemReply({id:plan.source.origin.reply.id,expectedSourceDigest:plan.source.origin.reply.sourceDigest})
      expect(source).toMatchObject({state:'routed',inputText:index===0?firstText:secondText,executionParentItemId:index===0?parent:child,child:{itemId:String(row.item_id)}})
    }
    for(const run of finalRuns.slice(1)) {
      const requests=f.supplier.requests.filter(r=>String(r.sessionId)===String(run.session_id))
      expect(requests.length).toBeGreaterThan(0)
      for(const request of requests) expect(request).toMatchObject({provider:'local',model:'scripted'})
    }
    expect(f.supplier.requests.filter(r=>!String(r.sessionId).startsWith('automation-'))).toHaveLength(foregroundRequests)
    expect(f.snapshot().budget).toHaveLength(3)
    expect(reportText).toContain('🧭')
  },100000)

  test('cold Delivery and WorkItems reopening deduplicates a provider retry after ACK without foreground replay',async()=>{
    const f=await replyFixture(),parent=await f.produce(),providerId=await acceptedReport(f,parent)
    const text='冷启动后仍保留这条输入与同一个续办任务🧭。'
    const first=await f.reply(providerId,text,'reply-cold')
    await f.ctx.assistantDelivery.tick();await f.waitRuns(2)
    const before=f.snapshot(),links=continuationRows(f)
    await f.reopen()
    const duplicate=await f.reply(providerId,text,'reply-cold')
    expect(duplicate).toMatchObject({duplicate:true,inboxId:first.inboxId,status:'processed'})
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantAutomations.whenIdle()
    expect(continuationRows(f)).toEqual(links);expect(f.snapshot().runs).toEqual(before.runs);expect(f.snapshot().budget).toEqual(before.budget)
    noForeground(f,first.inboxId)
    const origin=JSON.parse(String(links[0]!.plan_json)).source.origin.reply
    expect(f.ctx.assistantDelivery.readWorkItemReply({id:origin.id,expectedSourceDigest:origin.sourceDigest})).toMatchObject({state:'routed',inputText:text,child:{itemId:String(links[0]!.item_id)}})
    const owner=f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
    const sources=f.ctx.assistantDelivery.listPendingWorkItemReplies({scope:{workspace:f.root,preset:'primary'},owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},limit:20})
    expect(sources.items).toEqual([])
  },100000)


  test('cold reopen recovers a genuinely admitted child after ACK failure before any native dispatch',async()=>{
    const f=await replyFixture(),parent=await f.produce(),providerId=await acceptedReport(f,parent)
    const ack=vi.spyOn(f.ctx.assistantDelivery,'acknowledgeWorkItemReply').mockImplementation(()=>{throw new Error('fixture ACK unavailable before commit')})
    const text='真实admit后ACK暂时不可用，恢复只能使用同一个child。'
    const source=await f.reply(providerId,text,'reply-before-ack')
    await vi.waitFor(()=>expect(continuationRows(f)).toHaveLength(1),{timeout:15000})
    const admitted=continuationRows(f)[0]!
    expect(f.snapshot().runs).toHaveLength(1)
    expect(f.snapshot().budget).toHaveLength(1)
    expect(ack).toHaveBeenCalled()
    await f.stopWorkItems();ack.mockRestore();await f.reopen()
    await f.waitRuns(2)
    expect(continuationRows(f)).toEqual([admitted])
    noForeground(f,source.inboxId)
    expectPages(f,String(admitted.item_id),parent,parent,text)
  },100000)

  test('stop after real child admission but before ACK survives cold reopen, rejects ACK and releases open capacity without dispatch',async()=>{
    const f=await replyFixture(),parent=await f.produce(),providerId=await acceptedReport(f,parent)
    const requestCount=f.supplier.requests.length
    const ack=vi.spyOn(f.ctx.assistantDelivery,'acknowledgeWorkItemReply').mockImplementation(()=>{throw new Error('fixture ACK unavailable before cancellation')})
    const source=await f.reply(providerId,'先真实admit，ACK前停止，重开后必须释放容量。','reply-before-ack-stop')
    await vi.waitFor(()=>expect(continuationRows(f)).toHaveLength(1),{timeout:15000})
    const row=continuationRows(f)[0]!,child=String(row.item_id),plan=JSON.parse(String(row.plan_json)),origin=plan.source.origin.reply
    const planDigest=String(query(join(f.root,'items.sqlite'),`SELECT plan_digest FROM work_item_continuation WHERE item_id='${child}'`)[0]!.plan_digest)
    expect(ack).toHaveBeenCalled()
    expect(query(join(f.root,'items.sqlite'),`SELECT state FROM work_item WHERE id='${child}'`)).toEqual([{state:'queued'}])
    expect(f.snapshot().runs).toHaveLength(1);expect(f.snapshot().budget).toHaveLength(1)
    await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'stop-before-ack',occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text:'/stop'})
    await f.stopWorkItems();ack.mockRestore();await f.reopen()
    expect(()=>f.ctx.assistantDelivery.acknowledgeWorkItemReply({id:origin.id,expectedSourceDigest:origin.sourceDigest,childItemId:child,childPlanDigest:planDigest})).toThrow(expect.objectContaining({code:'work-item-reply-cancelled'}))
    await vi.waitFor(()=>expect(query(join(f.root,'items.sqlite'),`SELECT state,state_reason FROM work_item WHERE id='${child}'`)).toEqual([{state:'dropped',state_reason:'signal-withdrawn'}]))
    expect(query(join(f.root,'items.sqlite'),"SELECT id FROM work_item WHERE state IN ('queued','claimed','working','waiting')")).toEqual([])
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    expect(continuationRows(f)).toEqual([row]);expect(f.snapshot().runs).toHaveLength(1);expect(f.snapshot().budget).toHaveLength(1)
    expect([...f.supplier.pages.values()].flat().filter(page=>page.itemId===child)).toEqual([])
    expect(f.supplier.requests).toHaveLength(requestCount)
    noForeground(f,source.inboxId)
  },100000)

  test('a reply received before parent quiescence waits, then a real stop fences its durable source',async()=>{
    const f=await replyFixture({holdSummary:true}),producing=f.produce()
    try {
      const parent=await f.waitParentReport(),providerId=await acceptedReport(f,parent)
      const reply=await f.reply(providerId,'尚在执行时收到的追加说明，随后明确停止。','reply-stop')
      await f.ctx.assistantDelivery.tick()
      await vi.waitFor(()=>expect(f.operator!.getInbox(reply.inboxId)?.status).toBe('processed'))
      expect(continuationRows(f)).toEqual([])
      const owner=f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
      const pending=f.ctx.assistantDelivery.listPendingWorkItemReplies({scope:{workspace:f.root,preset:'primary'},owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},limit:20}).items.find(source=>source.id===reply.inboxId)!
      expect(pending).toBeDefined()
      await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'stop-reply',occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text:'/stop'})
      expect(()=>f.ctx.assistantDelivery.readWorkItemReply({id:pending.id,expectedSourceDigest:pending.sourceDigest})).toThrow(expect.objectContaining({code:'work-item-reply-cancelled'}))
      f.releaseSummary();await producing
      await f.restart();await f.ctx.assistantDelivery.tick();await f.ctx.assistantAutomations.whenIdle()
      expect(continuationRows(f)).toEqual([]);expect(f.snapshot().budget).toHaveLength(1)
      noForeground(f,reply.inboxId)
    } finally {f.releaseSummary();await producing}
  },100000)
  test('stop cancels a routed child at a real pending native tool and fences later reads and reports',async()=>{
    const f=await replyFixture(),parent=await f.produce(),providerId=await acceptedReport(f,parent)
    let release!:()=>void,entered=false,signal:AbortSignal|undefined
    const gate=new Promise<void>(resolve=>{release=resolve})
    const remove=f.ctx.on('tools/pre-execute',async(execution,next)=>{
      if(execution.name==='work_item_read_context'&&!entered) {entered=true;signal=execution.signal;await gate}
      return next()
    },{prepend:true})
    try {
      const source=await f.reply(providerId,'这条续办先进入真实worker，再由主人明确停止。','reply-active-stop')
      await vi.waitFor(()=>expect(entered).toBe(true),{timeout:15000})
      const row=continuationRows(f)[0]!,child=String(row.item_id),origin=JSON.parse(String(row.plan_json)).source.origin.reply
      expect(f.ctx.assistantDelivery.readWorkItemReply({id:origin.id,expectedSourceDigest:origin.sourceDigest})).toMatchObject({state:'routed',child:{itemId:child}})
      await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:'stop-active-reply',occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text:'/stop'})
      await vi.waitFor(()=>expect(signal?.aborted).toBe(true))
      expect(()=>f.ctx.assistantDelivery.readWorkItemReply({id:origin.id,expectedSourceDigest:origin.sourceDigest})).toThrow(expect.objectContaining({code:'work-item-reply-cancelled'}))
      release();const runs=await f.waitRuns(2)
      expect(runs[1]!.status).not.toBe('succeeded')
      expect(query(join(f.root,'items.sqlite'),`SELECT * FROM work_item_report WHERE item_id='${child}'`)).toEqual([])
      expect([...f.supplier.pages.values()].flat().filter(page=>page.itemId===child)).toEqual([])
      noForeground(f,source.inboxId)
      const before=f.snapshot();await f.restart();await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
      expect(continuationRows(f)).toHaveLength(1);expect(f.snapshot().runs).toEqual(before.runs);expect(f.snapshot().budget).toEqual(before.budget)
    } finally {release();remove()}
  },100000)

})
