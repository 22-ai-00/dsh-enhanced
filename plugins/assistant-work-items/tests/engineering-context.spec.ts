import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { continuationDigest } from '../src/continuation-record.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { engineeringFixture } from './engineering-context.fixture.ts'
afterEach(()=>vi.restoreAllMocks())
test('sealed diagnosis plus distinct v2 requests preserves raw text and fixed parent context',async()=>{
 const f=await engineeringFixture()
 try {
  const parent=f.diagnosisParent()
  const rootCap=f.feedbackCap(parent.item.id)
  expect(rootCap).toBeDefined()
  const root=f.engineering.issue(rootCap)
  expect(f.engineering.resolve(root)?.nodes).toHaveLength(1)
  f.add('first-engineering-reply','第一层 e\u0301\0😀',1,parent.item.id);f.consumer.drain()
  const first=f.child('first-engineering-reply')!
  expect(first).toBeDefined();f.finish(first)
  f.add('second-engineering-reply','第二层改为方案 B',2,parent.item.id);f.consumer.drain()
  const second=f.child('second-engineering-reply')!
  expect(second).toBeDefined();f.finish(second)
  const old=f.feedbackCap(second.id),before=f.feedback.resolve(old)
  expect(before).toBeDefined()
  const cap=f.engineering.issue(old),material=f.engineering.resolve(cap)
  expect(material).toBeDefined()
  expect(material?.nodes.map(n=>n.itemId)).toEqual([parent.item.id,first.id,second.id])
  expect(material?.continuationInputs.map(n=>n.text)).toEqual(['第一层 e\u0301\0😀','第二层改为方案 B'])
  expect(material?.parentReports.map(n=>n.itemId)).toEqual([parent.item.id,first.id])
  expect(f.feedback.resolve(old)).toEqual(before)
  expect(Object.isFrozen(material?.nodes)).toBe(true)
 }finally{f.close()}
})

test('legacy v1 child abstains while its original feedback capability remains valid',async()=>{
 const f=await engineeringFixture()
 try{const cap=f.feedbackCap(f.root.id),before=f.feedback.resolve(cap);expect(before).toBeDefined();expect(f.engineering.issue(cap)).toBeUndefined();expect(f.feedback.resolve(cap)).toEqual(before)}finally{f.close()}
})

test('capabilities are local, aligned, frozen and bounded with duplicate identity preserved',async()=>{
 const f=await engineeringFixture(),other=await engineeringFixture()
 try{
  const root=f.diagnosisParent(),foreign=other.diagnosisParent(),cap=f.engineering.issue(f.feedbackCap(root.item.id)),otherCap=other.engineering.issue(other.feedbackCap(foreign.item.id))
  expect(cap).toBeDefined();expect(otherCap).toBeDefined()
  f.engineering.withTargetsFence([cap,undefined,{},otherCap,cap],m=>{expect(m[0]).toBeDefined();expect(m[1]).toBeUndefined();expect(m[2]).toBeUndefined();expect(m[3]).toBeUndefined();expect(m[4]).toEqual(m[0]);expect(Object.isFrozen(m)).toBe(true)})
  expect(()=>f.engineering.withTargetsFence(Array(1001).fill(cap),()=>{})).toThrow(/1000/u)
  const getter=vi.fn(()=>cap),values:unknown[]=[];Object.defineProperty(values,'0',{enumerable:true,get:getter})
  expect(()=>f.engineering.withTargetsFence(values,()=>{})).toThrow(/dense/u);expect(getter).not.toHaveBeenCalled()
  const sparse:unknown[]=[];sparse.length=1
  expect(()=>f.engineering.withTargetsFence(sparse,()=>{})).toThrow(/dense/u)
 }finally{f.close();other.close()}
})

test('sync callback throw and thenable rollback release the writer and clear owner frame metadata',async()=>{
 const f=await engineeringFixture()
 try{
  const root=f.diagnosisParent(),cap=f.engineering.issue(f.feedbackCap(root.item.id))
  expect(()=>f.engineering.withTargetsFence([cap],()=>{f.store.setMeta('engineering-test','throw');throw new Error('consumer failed')})).toThrow(/consumer failed/u)
  expect(f.store.meta('engineering-test')).toBeNull()
  expect(f.feedback.engineeringFrameOwner()).toBeUndefined()
  // An intentionally hostile thenable verifies synchronous transaction rejection.
  // eslint-disable-next-line unicorn/no-thenable
  expect(()=>f.engineering.withTargetsFence([cap],()=>{f.store.setMeta('engineering-test','thenable');return {then:()=>{}}})).toThrow(/synchronous/u)
  expect(f.store.meta('engineering-test')).toBeNull()
  expect(f.feedback.engineeringFrameOwner()).toBeUndefined()
  f.engineering.withTargetsFence([cap],m=>{expect(m[0]).toBeDefined();f.store.setMeta('engineering-test','success')})
  expect(f.store.meta('engineering-test')).toBe('success')
 }finally{f.close()}
})

test('closed or replaced current service rejects rather than running the consumer',async()=>{
 const f=await engineeringFixture()
 try{const root=f.diagnosisParent(),cap=f.engineering.issue(f.feedbackCap(root.item.id)),consumer=vi.fn();f.deactivate();expect(f.engineering.resolve(cap)).toBeUndefined();expect(()=>f.engineering.withTargetsFence([cap],consumer)).toThrow(/unavailable/u);expect(consumer).not.toHaveBeenCalled()}finally{f.close()}
})

test('32 parent links are supported and a 33rd link rejects without truncation',async()=>{
 const f=await engineeringFixture()
 try{
  const root=f.diagnosisParent();let last=root.item
  for(let n=1;n<=33;n++){f.add(`depth-reply-${n}`,`original instruction ${n}`,n,root.item.id);f.consumer.drain();last=f.child(`depth-reply-${n}`)!;expect(last).toBeDefined();f.finish(last)
   if(n===32){const cap=f.engineering.issue(f.feedbackCap(last.id));expect(f.engineering.resolve(cap)?.nodes).toHaveLength(33)}
  }
  expect(f.engineering.issue(f.feedbackCap(last.id))).toBeUndefined()
 }finally{f.close()}
})

function sql(f:Awaited<ReturnType<typeof engineeringFixture>>,callback:(db:DatabaseSync)=>void){const db=new DatabaseSync(f.config.databasePath);db.exec('PRAGMA busy_timeout=0');db.exec('PRAGMA foreign_keys=OFF');try{callback(db)}finally{db.close()}}
async function chainFixture(){const f=await engineeringFixture(),root=f.diagnosisParent();f.add('context-reply','exact child e\u0301\0😀',1,root.item.id);f.consumer.drain();const child=f.child('context-reply')!;f.finish(child);return{f,root,child}}
function reseal(f:Awaited<ReturnType<typeof engineeringFixture>>,id:string,mutate:(plan:Record<string,any>)=>void){const record=f.store.getContinuation(id)!,plan=JSON.parse(record.planJson);mutate(plan);delete plan.digest;plan.digest=acceptanceDigest(plan);const text=acceptanceCanonicalJson(plan);sql(f,db=>{db.exec('DROP TRIGGER IF EXISTS work_item_continuation_no_update');db.prepare('UPDATE work_item_continuation SET plan_json=?,plan_digest=?,parent_report_revision=?,parent_outcome_revision=?,parent_item_id=?,root_item_id=? WHERE item_id=?').run(Buffer.from(text),continuationDigest(text),plan.parent.reportRevision,plan.parent.outcomeRevision,plan.parent.itemId,plan.parent.rootItemId,id)})}

test('fixed historical report survives later reports and delivery bookkeeping, but exact body drift invalidates the cap',async()=>{
 const {f,root,child}=await chainFixture()
 try{
  const cap=f.engineering.issue(f.feedbackCap(child.id)),before=f.engineering.resolve(cap);expect(before).toBeDefined()
  sql(f,db=>{db.prepare("INSERT INTO work_item_report (item_id,revision,status,summary,truncated,artifact_paths,idempotency_key,delivery_key,recorded_at) VALUES (?,2,'progress',?,0,'[]','later-report','later-delivery',?)").run(root.item.id,'later report is not selected',f.f.now());db.prepare("UPDATE work_item_report SET delivery_state='sent',delivery_id='sent-later' WHERE item_id=? AND revision=1").run(root.item.id)})
  expect(f.engineering.resolve(cap)).toEqual(before)
  sql(f,db=>db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('Diagnosis result\0changed hidden suffix',root.item.id))
  expect(f.engineering.resolve(cap)).toBeUndefined()
 }finally{f.close()}
})

test('null parent report cutoff is frozen no-background even when a later report exists',async()=>{
 const {f,root,child}=await chainFixture()
 try{
  reseal(f,child.id,plan=>{plan.parent.reportRevision=null})
  const cap=f.engineering.issue(f.feedbackCap(child.id)),before=f.engineering.resolve(cap)
  expect(before).toBeDefined();expect(before?.nodes[1]?.parent?.report).toBeNull();expect(before?.parentReports).toEqual([])
  sql(f,db=>db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('unselected changed report',root.item.id))
  expect(f.engineering.resolve(cap)).toEqual(before)
 }finally{f.close()}
})

test.each(['missing-report','missing-ancestor','wrong-owner','regressed-generation','cycle','wrong-root','missing-outcome'] as const)('sealed chain rejects %s',async(kind)=>{
 const {f,root,child}=await chainFixture()
 try{
  const old=f.feedbackCap(child.id);expect(old).toBeDefined()
  if(kind==='missing-report')sql(f,db=>db.prepare('DELETE FROM work_item_report WHERE item_id=? AND revision=1').run(root.item.id))
  if(kind==='missing-ancestor')sql(f,db=>db.prepare('DELETE FROM work_item WHERE id=?').run(root.item.id))
  if(kind==='wrong-owner')sql(f,db=>db.prepare("UPDATE work_item SET principal_record_id='foreign-owner' WHERE id=?").run(root.item.id))
  if(kind==='regressed-generation')sql(f,db=>db.prepare('UPDATE work_item SET owner_generation=99 WHERE id=?').run(root.item.id))
  if(kind==='cycle')reseal(f,child.id,plan=>{plan.parent.itemId=child.id;plan.source.origin.supplier.itemId=child.id})
  if(kind==='wrong-root')reseal(f,child.id,plan=>{plan.parent.rootItemId='foreign-root'})
  if(kind==='missing-outcome')reseal(f,child.id,plan=>{plan.parent.outcomeRevision=999})
  expect(f.engineering.issue(old)).toBeUndefined()
 }finally{f.close()}
})

test('last foreign owner callback cannot mutate an ancestor through a second writer',async()=>{
 const {f,root,child}=await chainFixture()
 try{
  const cap=f.engineering.issue(f.feedbackCap(child.id));expect(cap).toBeDefined()
  const original=f.delivery.validateOwnerRoute,attempts:string[]=[]
  f.delivery.validateOwnerRoute=input=>{try{sql(f,db=>db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=?').run('concurrent corruption',root.item.id));attempts.push('unexpected-write')}catch(error){attempts.push(String(error))}return original(input)}
  expect(f.engineering.resolve(cap)).toBeDefined();expect(attempts.length).toBeGreaterThan(0);expect(attempts.every(value=>value.includes('locked'))).toBe(true)
 }finally{f.close()}
})

test('disposal inside the last foreign owner read prevents any engineering consumer',async()=>{
 const {f,child}=await chainFixture()
 try{
  const cap=f.engineering.issue(f.feedbackCap(child.id)),original=f.delivery.validateOwnerRoute,consumer=vi.fn();let reads=0
  f.delivery.validateOwnerRoute=input=>{const result=original(input);if(++reads===3)f.deactivate();return result}
  expect(()=>f.engineering.withTargetsFence([cap],consumer)).toThrow(/current|unavailable/u);expect(consumer).not.toHaveBeenCalled();expect(f.feedback.engineeringFrameOwner()).toBeUndefined()
 }finally{f.close()}
})

test('raw input bound is cumulative and never truncates authenticated instructions',async()=>{
 const f=await engineeringFixture()
 try{
  const root=f.diagnosisParent()
  f.add('large-first','一'.repeat(3000),1,root.item.id);f.consumer.drain();const first=f.child('large-first')!;f.finish(first)
  expect(f.engineering.issue(f.feedbackCap(first.id))).toBeDefined()
  f.add('large-second','二'.repeat(3000),2,root.item.id);f.consumer.drain();const second=f.child('large-second')!;f.finish(second)
  expect(f.feedback.resolve(f.feedbackCap(second.id))).toBeDefined()
  expect(f.engineering.issue(f.feedbackCap(second.id))).toBeUndefined()
 }finally{f.close()}
})

test('whitespace-only continuation input abstains independently of its sealed hash',async()=>{
 const {f,child}=await chainFixture()
 try{
  const text=' \n\t',sha=continuationDigest(text),bytes=Buffer.byteLength(text)
  reseal(f,child.id,plan=>{plan.source.inputSha256=sha;plan.source.inputBytes=bytes;plan.source.origin.reply.inputSha256=sha;plan.source.origin.reply.inputBytes=bytes})
  sql(f,db=>db.prepare('UPDATE work_item_continuation SET input_text=?,input_sha256=? WHERE item_id=?').run(Buffer.from(text),sha,child.id))
  expect(f.feedback.resolve(f.feedbackCap(child.id))).toBeDefined()
  expect(f.engineering.issue(f.feedbackCap(child.id))).toBeUndefined()
 }finally{f.close()}
})

test('current owner generation may advance after new Session but cannot regress below sealed history',async()=>{
 const {f,child}=await chainFixture()
 try{
  const original=f.delivery.validateOwnerRoute,cap=f.engineering.issue(f.feedbackCap(child.id)),before=f.engineering.resolve(cap)
  expect(before).toBeDefined()
  f.delivery.validateOwnerRoute=input=>({...original(input),generation:original(input).generation+1,bindingVersion:1})
  expect(f.engineering.resolve(cap)).toEqual(before)
  f.delivery.validateOwnerRoute=input=>({...original(input),generation:1})
  expect(f.engineering.resolve(cap)).toBeUndefined()
 }finally{f.close()}
})

test('historical engineering source survives expired execution grants without calling execution APIs',async()=>{
 const {f,child}=await chainFixture()
 try{const cap=f.engineering.issue(f.feedbackCap(child.id)),before=f.engineering.resolve(cap);expect(before).toBeDefined();f.f.advance(3600001);expect(f.engineering.resolve(cap)).toEqual(before)}finally{f.close()}
})

test('the report aggregate bound rejects full text rather than silently dropping background',async()=>{
 const f=await engineeringFixture()
 try{
  const root=f.diagnosisParent(),parents=[root.item.id];let last=root.item
  for(let n=1;n<=5;n++){f.add(`report-bound-${n}`,`request ${n}`,n,root.item.id);f.consumer.drain();last=f.child(`report-bound-${n}`)!;f.finish(last);if(n<5)parents.push(last.id)}
  sql(f,db=>{for(const id of parents)db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('x'.repeat(65536),id)})
  expect(f.feedback.resolve(f.feedbackCap(last.id))).toBeDefined();expect(f.engineering.issue(f.feedbackCap(last.id))).toBeUndefined()
 }finally{f.close()}
})

test('last owner callback same-connection outcome update invalidates the selected chain before consumer use',async()=>{
 const {f,root,child}=await chainFixture()
 try{
  const selected=f.store.continuationParentOutcomes(child.id,0,1)[0]!
  expect(selected.itemId).toBe(root.item.id);expect(selected.evaluationAttempts).toBe(0)
  const cap=f.engineering.issue(f.feedbackCap(child.id));expect(f.engineering.resolve(cap)).toBeDefined()
  const original=f.delivery.validateOwnerRoute,consumer=vi.fn();let reads=0,updated=false
  f.delivery.validateOwnerRoute=input=>{
   const owner=original(input)
   // read() has two owner reads; the third is the group's final foreign read.
   if(++reads===3){const outcome=f.store.recordOutcomeEvaluationAttempt(root.item.id,selected.revision,5);expect(outcome.evaluationAttempts).toBe(1);updated=true}
   return owner
  }
  f.engineering.withTargetsFence([cap],materials=>{expect(updated).toBe(true);expect(materials).toEqual([undefined]);if(materials[0])consumer(materials[0])})
  expect(reads).toBe(3);expect(consumer).not.toHaveBeenCalled()
  expect(f.store.continuationParentOutcomes(child.id,0,1)[0]?.evaluationAttempts).toBe(1)
  expect(f.engineering.resolve(cap)).toBeUndefined()
  expect(f.feedback.engineeringFrameOwner()).toBeUndefined()
 }finally{f.close()}
})
