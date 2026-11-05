import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.js'
import { DeliveryStore } from '../src/store.js'
import { WorkItemReplyCancelledError, workItemReplyDigest, type WorkItemReplyConsumerRegistration, type WorkItemReportTarget } from '../src/work-item-replies.js'

const roots: string[] = [], contexts: Context[] = []
const principal = { channel: 'lark', account: 'reply-test', tenant: 'tenant', user: 'owner' }
const conversation = { channel: principal.channel, account: principal.account, tenant: principal.tenant, kind: 'dm' as const, chat: 'owner-chat' }
const scope = { workspace: '/work/replies', preset: 'primary' }
const producerId = 'work-items-source', automationId = 'reply-worker'
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true})))
})
function sql<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path); try { return action(db) } finally { db.close() }
}
async function fixture(options: { root?: string; allow?: boolean; unknown?: boolean } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(),'delivery-work-item-replies-'))
  if (!options.root) roots.push(root)
  const path = join(root,'delivery.sqlite'), ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root,'policy.sqlite'), rules: [
    { id:'ingest',effect:'allow',subject:{kind:'external',id:'lark/reply-test/tenant/owner'},actions:['ingest'],resource:{kind:'message',id:'*'},context:{initiators:['external']} },
    { id:'send',effect:'allow',subject:{kind:'background',id:producerId,workspace:scope.workspace,principal:'lark/reply-test/tenant/owner'},actions:['send'],resource:{kind:'message',id:'*'},context:{initiators:['background']} },
    ...(options.allow === false ? [] : [{ id:'continue',effect:'allow' as const,subject:{kind:'external' as const,id:'lark/reply-test/tenant/owner'},actions:['continue-work-items-from-reply'],resource:{kind:'automation' as const,id:automationId},context:{initiators:['external' as const]} }]),
  ] })
  await ctx.plugin(AssistantDeliveryService,{ databasePath:path,spoolPath:join(root,'spool'),schedulerEnabled:false })
  const service=ctx.assistantDelivery, store=(service as unknown as {deliveryStore:DeliveryStore}).deliveryStore
  if (!store.getPrincipal(principal)) {
    const pair=store.issuePairing(principal,{ttlMs:60000,maxAttempts:3});store.confirmPairing({challengeId:pair.challenge.id,principal,code:pair.code})
  }
  const binding=store.getActiveBinding(conversation) ?? store.createBinding({conversation,principal,workspace:scope.workspace,agentPreset:scope.preset,sessionId:'original-session',policyRef:'owner'})
  const row=store.getPrincipal(principal)!,owner={principalRecordId:row.id,principalVersion:row.version}
  const targets=new Map<string,{target:WorkItemReportTarget;text:string;key:string;bindingId:string}>()
  let owns=true
  const registration:WorkItemReplyConsumerRegistration={protocol:1,sourceId:producerId,continuationAutomationId:automationId,
    inspectReport:vi.fn(input=>{
      const report=targets.get(input.itemId)
      return report && report.text===input.text && report.key===input.idempotencyKey && report.bindingId===input.bindingId && report.target.reportRevision===input.reportRevision ? report.target : undefined
    }),inspectChild:vi.fn(()=>true),onPending:vi.fn(),onCancelled:vi.fn()}
  ctx.provide('assistantWorkItems' as never,{ownsWorkItemReplyRegistration:(input:unknown)=>owns && input===registration} as never)
  let unregister=service.registerWorkItemReplyConsumer(registration)
  service.registerInboundRuntime({createSession:async input=>({sessionId:`session-${input.generation}`,workspace:scope.workspace,agentPreset:scope.preset,policyRef:'owner'}),process:async()=>({outcome:'processed'})})
  let sent=0
  await service.registerAdapter({channel:principal.channel,account:principal.account,capabilities:{formats:['plain','markdown'],receipts:[],reconcileUnknownSend:false},start:async()=>{},send:async()=>options.unknown ? {outcome:'unknown',failureCode:'unknown'} : {outcome:'accepted',providerMessageId:`report-${++sent}`}})
  async function report(itemId='P',streamId=itemId, generic=false) {
    const target:WorkItemReportTarget={protocol:'assistant-delivery/work-item-report/v1',itemId,reportRevision:1,streamId,reportDigest:workItemReplyDigest(['report',itemId]),sourceId:producerId,scope,owner}
    const input={sourceId:producerId,workspace:scope.workspace,bindingId:binding.id,idempotencyKey:`report:${itemId}`,text:`Report ${itemId}`,format:'plain' as const,itemId,reportRevision:1}
    targets.set(itemId,{target,text:input.text,key:input.idempotencyKey,bindingId:binding.id})
    const outbox=generic ? service.enqueueBackground({...input,metadata:{'work-item-report':itemId,'work-item-report.kind':'report'}}) : service.enqueueWorkItemReport(input)
    await service.tick();await service.whenIdle()
    return store.getOutbox(outbox.id)!
  }
  function envelope(eventId:string,text='继续 🧪\n原始回复',providerMessageId='report-1') {
    return {channel:principal.channel,account:principal.account,eventId,occurredAt:Date.now(),principal,conversation,kind:'text' as const,text,metadata:{replyToProviderMessageId:providerMessageId}}
  }
  return {root,path,ctx,service,store,binding,owner,registration,targets,report,envelope,
    owns:(value:boolean)=>{owns=value},unregister:()=>unregister(),reregister:()=>{unregister=service.registerWorkItemReplyConsumer(registration)},
    list:()=>service.listPendingWorkItemReplies({scope,owner,limit:100}).items}
}

// The peer is a narrow ownership fixture. Native integration separately uses the
// real WorkItems producer; no model or remote adapter is called in this suite.
describe('durable exclusive owner report replies',()=>{
  test('hands off real accepted reports exclusively, preserves lossless input, and deduplicates provider input',async()=>{
    const f=await fixture();const outbox=await f.report();const envelope=f.envelope('R1','继续\0保留 🧪')
    const accepted=await f.service.acceptInbound(envelope)
    expect(accepted.status).toBe('processed')
    expect(await f.service.acceptInbound(envelope)).toEqual({...accepted,duplicate:true})
    const source=f.list()[0]!
    expect(source).toMatchObject({id:accepted.inboxId,inputText:envelope.text,inputBytes:Buffer.byteLength(envelope.text),state:'pending',target:{outboxId:outbox.id,providerMessageId:'report-1',itemId:'P'}})
    expect(f.service.readWorkItemReply({id:source.id,expectedSourceDigest:source.sourceDigest})).toEqual(source)
    expect(f.store.claimInbox({ownerId:'foreground',leaseMs:1000,limit:10,maxAttempts:3})).toEqual([])
    sql(f.path,db=>expect(db.prepare('SELECT count(*) AS n FROM delivery_foreground_executions').get()?.n).toBe(0))
  })
  test('selects and ACKs one sequential head per stream, retaining target and immutable source after ACK',async()=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('R1'));await f.service.acceptInbound(f.envelope('R2','second'))
    const first=f.list()[0]!;expect(f.list()).toHaveLength(1)
    const input={id:first.id,expectedSourceDigest:first.sourceDigest}
    const selected=f.service.selectWorkItemReplyParent(input);expect(selected.executionParentItemId).toBe('P')
    expect(f.service.selectWorkItemReplyParent(input)).toEqual(selected)
    vi.mocked(f.registration.inspectChild).mockReturnValueOnce(false)
    expect(()=>f.service.acknowledgeWorkItemReply({...input,childItemId:'C1',childPlanDigest:'a'.repeat(64)})).toThrow()
    const ack=f.service.acknowledgeWorkItemReply({...input,childItemId:'C1',childPlanDigest:'a'.repeat(64)})
    expect(f.service.acknowledgeWorkItemReply({...input,childItemId:'C1',childPlanDigest:'a'.repeat(64)})).toEqual(ack)
    expect(()=>f.service.acknowledgeWorkItemReply({...input,childItemId:'forged',childPlanDigest:'b'.repeat(64)})).toThrow()
    expect(ack).toMatchObject({sourceDigest:first.sourceDigest,inputText:first.inputText,state:'routed',child:{itemId:'C1',planDigest:'a'.repeat(64)}})
    const second=f.list()[0]!,secondInput={id:second.id,expectedSourceDigest:second.sourceDigest}
    expect(f.service.selectWorkItemReplyParent(secondInput)).toMatchObject({executionParentItemId:'C1',target:{itemId:'P',streamId:'P'}})
  })
  test.each(['generic','unknown','policy','producer','command','attachment','foreign-conversation','ambiguous-address'] as const)('keeps %s input on the ordinary foreground path',async fault=>{
    const f=await fixture({allow:fault!=='policy',unknown:fault==='unknown'});const report=await f.report('P','P',fault==='generic')
    if(fault==='producer')f.owns(false)
    if(fault==='ambiguous-address'){
      const other=await f.report('other')
      sql(f.path,db=>{db.exec('DROP INDEX outbox_provider_message');db.prepare('UPDATE outbox_messages SET provider_message_id=? WHERE id=?').run(report.providerMessageId!,other.id)})
    }
    const envelope=f.envelope('ordinary',fault==='command'?'/help':'ordinary',report.providerMessageId??'unknown-provider')
    if(fault==='foreign-conversation')envelope.conversation={...conversation,chat:'other-chat'}
    const result=await f.service.acceptInbound({...envelope,...(fault==='attachment'?{attachments:[{resourceType:'file',providerRef:'file-ref',fileName:'document'}]}:{})} as Parameters<AssistantDeliveryService['acceptInbound']>[0])
    expect(result.status).toBe('queued')
    sql(f.path,db=>expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(0))
  })
  test('advances a bounded raw scan past a filtered stream and revisits waiting streams after wrap',async()=>{
    const f=await fixture()
    for(const item of ['P','A','B']){const report=await f.report(item);await f.service.acceptInbound(f.envelope(`reply-${item}`,item,report.providerMessageId!))}
    const inspect=f.registration.inspectReport
    vi.mocked(inspect).mockImplementation(input=>input.itemId==='P'?undefined:f.targets.get(input.itemId)?.target)
    const first=f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:1})
    expect(first).toMatchObject({items:[],hasMore:true,nextAfterSequence:expect.any(Number)})
    const second=f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:1,afterSequence:first.nextAfterSequence!})
    expect(second.items[0]?.target.itemId).toBe('A');expect(second.hasMore).toBe(true)
    const third=f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:1,afterSequence:second.nextAfterSequence!})
    expect(third.items[0]?.target.itemId).toBe('B');expect(third).toMatchObject({hasMore:false,nextAfterSequence:null})
    expect(f.service.listPendingWorkItemReplies({scope,owner:f.owner,limit:1})).toEqual(first)
  })
  test('refuses forged typed target and caller source without creating an outbox sidecar',async()=>{
    const f=await fixture()
    expect(()=>f.service.enqueueWorkItemReport({sourceId:producerId,workspace:scope.workspace,bindingId:f.binding.id,idempotencyKey:'forged',text:'fake',itemId:'P',reportRevision:1})).toThrow()
    await f.report()
    expect(()=>f.service.enqueueWorkItemReport({sourceId:'unowned',workspace:scope.workspace,bindingId:f.binding.id,idempotencyKey:'other',text:'Report P',itemId:'P',reportRevision:1})).toThrow()
    sql(f.path,db=>expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_reports').get()?.n).toBe(1))
  })
  test('never returns an admitted source to foreground when producer or policy disappears',async()=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('exclusive'));const source=f.list()[0]!,input={id:source.id,expectedSourceDigest:source.sourceDigest}
    f.unregister();expect(()=>f.service.readWorkItemReply(input)).toThrow();expect(f.store.getInbox(source.id)?.status).toBe('processed')
    f.reregister();expect(f.service.readWorkItemReply(input).sourceDigest).toBe(source.sourceDigest)
    f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'test'})
    expect(()=>f.service.readWorkItemReply(input)).toThrow();expect(f.store.getInbox(source.id)?.status).toBe('processed')
  })
  test.each(['/stop','/new','/clear'])('durably fences pending and routed replies before %s, notifying only after commit',async command=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('R1'));const first=f.list()[0]!,input={id:first.id,expectedSourceDigest:first.sourceDigest}
    f.service.selectWorkItemReplyParent(input);f.service.acknowledgeWorkItemReply({...input,childItemId:'C1',childPlanDigest:'a'.repeat(64)})
    await f.service.acceptInbound(f.envelope('R2'));const second=f.list()[0]!
    vi.mocked(f.registration.onCancelled).mockImplementation(ids=>{expect(ids).toEqual(['C1']);sql(f.path,db=>expect(db.prepare("SELECT count(*) AS n FROM delivery_work_item_replies WHERE state='cancelled'").get()?.n).toBe(2))})
    await f.service.acceptInbound({...f.envelope('cancel',command),kind:'command'})
    expect(f.registration.onCancelled).toHaveBeenCalledWith(['C1'])
    for(const source of [first,second])expect(()=>f.service.readWorkItemReply({id:source.id,expectedSourceDigest:source.sourceDigest})).toThrow(WorkItemReplyCancelledError)
    if(command!=='/stop'){
      const next=await f.service.acceptInbound(f.envelope('R3','reply after new'))
      expect(next.status).toBe('processed')
      const selected=f.service.selectWorkItemReplyParent({id:f.list()[0]!.id,expectedSourceDigest:f.list()[0]!.sourceDigest})
      expect(selected).toMatchObject({executionParentItemId:'C1',binding:{generation:2},target:{itemId:'P'}})
    }
  })
  test.each(['read','select','ack'] as const)('fences reentrant Policy revocation after the last producer callback during %s',async operation=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope(`reentrant-${operation}`));const source=f.list()[0]!,input={id:source.id,expectedSourceDigest:source.sourceDigest}
    const revoke=()=>f.ctx.assistantPolicy.setEmergencyStop({enabled:true,actor:'owner',reason:'producer reentrancy'})
    if(operation==='ack'){
      f.service.selectWorkItemReplyParent(input)
      vi.mocked(f.registration.inspectChild).mockImplementation(()=>{revoke();return true})
      expect(()=>f.service.acknowledgeWorkItemReply({...input,childItemId:'forbidden-child',childPlanDigest:'f'.repeat(64)})).toThrow()
    }else{
      vi.mocked(f.registration.inspectReport).mockImplementation(()=>{revoke();return f.targets.get('P')!.target})
      expect(()=>operation==='read'?f.service.readWorkItemReply(input):f.service.selectWorkItemReplyParent(input)).toThrow()
    }
    sql(f.path,db=>{
      expect(db.prepare('SELECT state,child_item_id FROM delivery_work_item_replies WHERE inbox_id=?').get(source.id)).toEqual({state:'pending',child_item_id:null})
      expect(db.prepare('SELECT head_item_id,revision FROM delivery_work_item_reply_streams').get()).toEqual({head_item_id:'P',revision:0})
    })
  })
  test('cold reopening requires fresh owned registration and retains selected source, ACK and head',async()=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('cold'));const original=f.list()[0]!,input={id:original.id,expectedSourceDigest:original.sourceDigest}
    f.service.selectWorkItemReplyParent(input)
    await f.ctx.fiber.dispose()
    const next=await fixture({root:f.root});for(const [key,value]of f.targets)next.targets.set(key,value)
    expect(next.service.readWorkItemReply(input)).toMatchObject({sourceDigest:original.sourceDigest,executionParentItemId:'P',inputText:original.inputText})
    const ack=next.service.acknowledgeWorkItemReply({...input,childItemId:'cold-child',childPlanDigest:'c'.repeat(64)})
    expect(next.service.readWorkItemReply(input)).toEqual(ack)
  })
  test('rejects stale owner lineage, immutable source edits and missing schema protections',async()=>{
    const f=await fixture();await f.report();await f.service.acceptInbound(f.envelope('protected'));const source=f.list()[0]!,input={id:source.id,expectedSourceDigest:source.sourceDigest}
    sql(f.path,db=>{
      expect(()=>db.prepare('UPDATE delivery_work_item_replies SET source_json=?').run('{}')).toThrow(/immutable/u)
      expect(()=>db.exec('DELETE FROM delivery_work_item_replies')).toThrow(/durable/u)
    })
    const owner=f.store.getPrincipal(principal)!;f.store.revokePrincipal(owner.id,owner.version)
    expect(()=>f.service.readWorkItemReply(input)).toThrow()
    await f.ctx.fiber.dispose()
    sql(f.path,db=>db.exec('DROP TRIGGER delivery_work_item_replies_source_immutable'))
    expect(()=>new DeliveryStore({path:f.path})).toThrow(/reply authority schema/u)
  })
})

test('migrates a genuine v28 database to v31 without changing old schema or data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'delivery-genuine-v28-'));roots.push(root);const path=join(root,'state.sqlite')
  const schema=await readFile(new URL('./fixtures/delivery-v28-schema.sql',import.meta.url),'utf8')
  const old=sql(path,db=>{db.exec(schema);db.prepare('INSERT INTO delivery_principals(id,key_hash,principal_json,role,status,created_at,updated_at,version) VALUES(?,?,?,\'owner\',\'active\',1,1,1)').run('principal_legacy','a'.repeat(64),JSON.stringify(principal));expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(28);return {schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),rows:db.prepare('SELECT * FROM delivery_principals').all()}})
  const store=new DeliveryStore({path});store.close()
  sql(path,db=>{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(31);expect(db.prepare('SELECT * FROM delivery_principals').all()).toEqual(old.rows);const names=new Set(old.schema.map(row=>row.name));expect(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all().filter(row=>names.has(row.name))).toEqual(old.schema);expect(db.prepare('SELECT count(*) AS n FROM delivery_work_item_replies').get()?.n).toBe(0)})
  const reopened=new DeliveryStore({path});reopened.close()
})
