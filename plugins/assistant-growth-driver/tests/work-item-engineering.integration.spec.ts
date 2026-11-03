import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import GrowthPlugin, { AssistantGrowthDriverService } from '../src/index.ts'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { verifyPluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityRuntime } from '../../plugin-control-plane/lib/creation-capability-runtime.js'
import { engineeringScanBudgetId, matchesApprovalSource, query, workItemEngineeringFixture } from './work-item-engineering.fixture.ts'

test('native fixture mounts the published Growth plugin identity rather than the Service constructor name',async()=>{
  const context=new Context()
  try {
    // Missing injections keep service execution dormant; names below come from
    // actual installed Cordis plugin/Fiber metadata, without models or peers.
    const constructorFork=context.plugin(AssistantGrowthDriverService,{enabled:false})
    const publishedFork=context.plugin(GrowthPlugin,{enabled:false})
    expect(constructorFork.name).toBe('AssistantGrowthDriverService')
    expect(publishedFork.name).toBe('dsh-enhanced-assistant-growth-driver')
  } finally {await context.fiber.dispose()}
})

// This verifies only the test transport's identity comparison. It creates no
// Delivery attestation, tool result, adoption or native-success evidence.
test('approval transport rejects another Inbox even for the same owner Session and binding',()=>{
  const expected={inboxId:'requested-inbox',sessionId:'owner-session',bindingId:'owner-binding'}
  const task={inboxId:'requested-inbox',sessionId:'owner-session',binding:{id:'owner-binding'}}
  expect(matchesApprovalSource(task,expected)).toBe(true)
  expect(matchesApprovalSource({...task,inboxId:'later-inbox'},expected)).toBe(false)
  expect(matchesApprovalSource({...task,sessionId:'other-session'},expected)).toBe(false)
  expect(matchesApprovalSource({...task,binding:{id:'other-binding'}},expected)).toBe(false)
  expect(matchesApprovalSource(undefined,expected)).toBe(false)
})

type Fixture=Awaited<ReturnType<typeof workItemEngineeringFixture>>
async function failedSource(f:Fixture,chain=false) {
  const rootItemId=await f.produce();await f.acceptReports()
  const sentReport=(id:string)=>{
    const row=query(join(f.root,'items.sqlite'),`SELECT delivery_id FROM work_item_report WHERE item_id='${id}'`)[0]!
    const report=f.operator!.getOutbox(String(row.delivery_id))!
    expect(report).toMatchObject({status:'accepted',providerMessageId:expect.any(String)})
    return report
  }
  let itemId=rootItemId,report=sentReport(itemId),childText:string|undefined
  if(chain){
    childText=`Correction for task ${f.supplier.tag}: additionally ignore lines whose first character is #. Keep the earlier pure parsing behavior and preserve all Unicode and equals signs in values.`
    await f.reply(report.providerMessageId!,childText,'engineering-owner-child')
    await vi.waitFor(async()=>{
      await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
      expect(query(join(f.root,'items.sqlite'),"SELECT id,state FROM work_item WHERE kind='owner-continuation'")).toEqual([expect.objectContaining({state:'ready'})])
      expect(query(join(f.root,'automations.sqlite'),'SELECT status,quiescent FROM automation_runs')).toEqual([expect.objectContaining({status:'succeeded',quiescent:1}),expect.objectContaining({status:'succeeded',quiescent:1})])
    },{timeout:30000})
    itemId=String(query(join(f.root,'items.sqlite'),"SELECT id FROM work_item WHERE kind='owner-continuation'")[0]!.id)
    await f.acceptReports();report=sentReport(itemId)
    const record=query(join(f.root,'items.sqlite'),`SELECT CAST(plan_json AS TEXT) AS plan_json FROM work_item_continuation WHERE item_id='${itemId}'`)[0]!
    expect(JSON.parse(String(record.plan_json))).toMatchObject({protocol:'assistant-work-items/owner-continuation-plan/v2'})
  }
  await f.reply(report.providerMessageId!,'还是不行','engineering-owner-failure')
  await vi.waitFor(async()=>{
    await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
    const canonical=f.ctx.assistantEvaluation.getTrustedWorkItemLearningProjection({scope:f.ctx.assistantEvaluation.createHostScope({workspace:f.workspace,preset:'primary'}),itemId})
    expect(canonical).toMatchObject({projection:{subjectKind:'work-item',subjectRef:itemId},objective:{status:'not-achieved'}})
  },{timeout:15000})
  return {itemId,rootItemId,childText,providerMessageId:report.providerMessageId!}
}
async function sourceJob(f:Fixture) {
  const deadline=Date.now()+180000
  while(!f.engineering.authorJobId){
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    const jobs=query(join(f.root,'engineering-usage.sqlite'),'SELECT id,state,reason FROM usage_jobs')
    if(jobs.some(job=>['unknown','ignored','superseded'].includes(String(job.state))))throw new Error('native author terminated without a source job: '+JSON.stringify({jobs,health:(f.ctx.get('assistantGrowthDriver' as never) as unknown as {health():unknown}).health(),warnings:f.warnings,source:f.sourceDiagnostics}))
    if(Date.now()>=deadline)throw new Error('actual author source job missing: '+JSON.stringify(f.warnings))
    if(!f.engineering.authorJobId)await new Promise(resolve=>setTimeout(resolve,50))
  }
  const owner=f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
  const caller={ownerRouteId:owner.authorityId,principalId:owner.principalId,principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion,workspace:owner.workspace,preset:owner.agentPreset}
  for(;;){
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    const job=f.ctx.pluginControlPlane.inspectSourceJob({id:f.engineering.authorJobId,owner:caller})
    if(['failed','unknown'].includes(job.status))throw new Error('real native source job did not prepare: '+JSON.stringify({job,warnings:f.warnings}))
    if(job.status==='prepared'){expect(job.planId).toEqual(expect.any(String));return job}
    if(Date.now()>=deadline)throw new Error('real source build did not settle in its bounded test window')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
}
async function adopted(f:Fixture) {
  const job=await sourceJob(f)
  const deadline=Date.now()+180000
  for(;;){
    await f.ctx.assistantAutomations.tick();await f.ctx.assistantAutomations.whenIdle()
    const aliases=f.ctx.tools.schemas().filter(t=>t.name.startsWith('evolved_owner_'))
    if(aliases.length){expect(aliases).toHaveLength(1);break}
    const verification=f.ctx.pluginControlPlane.inspectCreationVerification(job.planId!)
    if(verification&&['unknown','rejected'].includes(verification.status))throw new Error('independent verification terminal without an adopted alias: '+JSON.stringify({verification,warnings:f.warnings}))
    if(Date.now()>=deadline)throw new Error('real verified adoption did not produce an alias within its bounded test window')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  await f.saveNativeEvidence(job.planId!)
  return {job,alias:f.ctx.tools.schemas().find(t=>t.name.startsWith('evolved_owner_'))!.name}
}
function counts(f:Fixture) {
  return {paid:f.supplier.requests.filter(r=>r.tools?.some(t=>t.name==='plugin_source_gaps')||String(r.sessionId).startsWith('creation-')).length,
    reservations:query(join(f.root,'policy.sqlite'),'SELECT * FROM budget_reservations ORDER BY id'),
    authority:query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT * FROM authority'),
    adoptions:query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT plan_id,artifact_sha,certificate_digest,receipt_json FROM adoptions')}
}

/** Durable automation activity that a remount could legitimately advance.
 * The pre-execution work unit is an occurrence plus its task/attempt, and a run
 * whose diagnostic reports a finalized budget was inserted only after that
 * finalize in the separate Policy database. Runs can also be inserted while a
 * reservation stays unsettled (abort race, settlement failure), so callers take
 * this snapshot only after assistantAutomations reports idle, and additions must
 * then be settled. All three reads are synchronous on the one JS thread that also
 * performs every write here; the observation is therefore consistent. */
function activity(f:Fixture) {
  return {runs:query(join(f.root,'automations.sqlite'),'SELECT id,occurrence_id,automation_id,status,diagnostic_json FROM automation_runs ORDER BY id'),
    occurrences:query(join(f.root,'automations.sqlite'),'SELECT id,automation_id FROM automation_occurrences ORDER BY id'),
    reservations:query(join(f.root,'policy.sqlite'),'SELECT * FROM budget_reservations ORDER BY id')}
}
/** A remount may only add reservations that settle genuinely new occurrences of
 * the current frozen Host usage-scan definition, and may only settle a scan
 * reservation that was still in flight at the earlier snapshot. Every other
 * pre-existing reservation must survive field-for-field, and the runner's
 * idempotency digest binds each permitted settlement to one distinct occurrence
 * and run whose definition uses exactly the configured scan budget. Author,
 * review, source and build reservations can therefore never be replayed or
 * duplicated by the remount. Callers sample only after assistantAutomations is
 * idle, so every permitted addition is already settled when it is observed. */
function expectOnlyNewScanReservations(f:Fixture,before:ReturnType<typeof activity>,after:ReturnType<typeof activity>) {
  const scanRuns=query(join(f.root,'automations.sqlite'),`SELECT r.id AS run_id,r.occurrence_id,r.automation_id,r.definition_hash,r.status,r.diagnostic_json,d.definition_json FROM automation_runs r JOIN automation_definitions d ON d.id=r.automation_id AND d.definition_hash=r.definition_hash WHERE r.automation_id LIKE 'usage-scan-%'`)
  const bindsScanRun=(reservation:Record<string,unknown>,run:Record<string,unknown>)=>{
    const definition=JSON.parse(String(run['definition_json'])) as {budgetId?:unknown;budgetAmount?:unknown}
    if(definition.budgetId!==engineeringScanBudgetId||definition.budgetAmount!==1)return false
    const digest=createHash('sha256').update(JSON.stringify(['assistant-automations-host-budget/v1',String(run['automation_id']),String(run['occurrence_id']),String(run['definition_hash']),'automation-runs',definition.budgetId])).digest('hex')
    return reservation['idempotency_key']===`automation-budget:host:v1:${digest}`
  }
  const beforeById=new Map(before.reservations.map(row=>[String(row['id']),row]))
  for(const row of before.reservations) {
    const candidate=after.reservations.find(entry=>entry['id']===row['id'])
    // A scan reserved before the earlier snapshot settles afterwards, so the same
    // ledger row may legitimately advance reserved -> finalized/released. That is a
    // first settlement of an existing row, never an addition. Its own immutable
    // identity proves the scan family even when the run row is not yet recorded.
    if(row['status']==='reserved'&&candidate!==undefined&&(candidate['status']==='finalized'||candidate['status']==='released')) {
      const beforeRest={...row},afterRest={...candidate}
      const mutable=['status','version','updated_at',...(candidate['status']==='finalized'?['actual_amount']:[])]
      for(const key of mutable){delete beforeRest[key];delete afterRest[key]}
      expect(afterRest).toEqual(beforeRest)
      expect(row).toMatchObject({scope:expect.stringMatching(/^background:usage-scan-/u),metric:'automation-runs',amount:1})
      if(candidate['status']==='finalized') expect(candidate['actual_amount']).toBe(1)
      else expect(candidate['actual_amount']).toBeNull()
      continue
    }
    expect(candidate).toEqual(row)
  }
  const added=after.reservations.filter(row=>!beforeById.has(String(row['id'])))
  const beforeRunsById=new Map(before.runs.map(row=>[String(row['id']),row]))
  const boundOccurrences=new Set<string>()
  for(const reservation of added) {
    const matches=scanRuns.filter(run=>bindsScanRun(reservation,run))
    expect(matches).toHaveLength(1)
    const run=matches[0]!,occurrenceId=String(run['occurrence_id'])
    // The guard below is unreachable in this writer set: a settlement failure or
    // abort race leaves the reservation unsettled, which the settled addition below
    // rejects. It stays for a future claim-time run row and only accepts states
    // that consumed no budget.
    const priorRun=beforeRunsById.get(String(run['run_id']))
    if(priorRun!==undefined) {
      const priorDiagnostic=JSON.parse(String(priorRun['diagnostic_json'])) as {budgetSettlementState?:unknown}
      expect(['reserved','released','not-required']).toContain(priorDiagnostic.budgetSettlementState)
    }
    expect(after.occurrences.filter(row=>row['id']===occurrenceId)).toHaveLength(1)
    expect(boundOccurrences.has(occurrenceId)).toBe(false);boundOccurrences.add(occurrenceId)
    expect(reservation).toMatchObject({scope:`background:${String(run['automation_id'])}`,metric:'automation-runs',status:'finalized',amount:1,actual_amount:1})
    // A settled scan either reports a real outcome or stays unknown after the
    // execution boundary was crossed; the finalized settlement below pins that the
    // budget was consumed exactly once either way.
    expect(['succeeded','failed','timed_out','unknown']).toContain(run['status'])
    expect((JSON.parse(String(run['diagnostic_json'])) as {budgetSettlementState?:unknown}).budgetSettlementState).toBe('finalized')
  }
  // The scan budget admits a hard-capped number of settled runs; a wider delta
  // would mean some other reservation path advanced during the remount.
  expect(added.length).toBeLessThanOrEqual(5)
  return added
}

async function revise(f:Fixture,providerMessageId:string,text:string,id:string) {
  await f.ctx.assistantDelivery.acceptInbound({channel:'web',account:'browser',eventId:id,occurredAt:Date.now(),principal:f.principal,conversation:f.conversation,kind:'command',text,metadata:{replyToProviderMessageId:providerMessageId}})
  await f.ctx.assistantDelivery.tick();await f.ctx.assistantDelivery.whenIdle()
}

// This suite never simulates source builds, observer outcomes, certificates or
// adoption writes. Without an actual production-prepared runtime it is skipped;
// a skip establishes no native readiness or engineering acceptance.
// Measured Linux adoption exceeds 400s across bounded native stages; only the scenario watchdog differs.
const adoptionScenarioTimeout=process.platform==='linux'?600000:300000
describe.skipIf(!process.env['DSH_WORK_ITEM_ENGINEERING_RESOURCES']||!['darwin','linux'].includes(process.platform))('native owner WorkItem engineering growth',()=>{
  test('native component preflight validates current protocols and trust without dispatching an author',async()=>{
    const f=await workItemEngineeringFixture()
    // The source Inbox is still pending. This is only real component/config
    // readiness; no completed source, native build or behavioral success.
    await f.mountEngineering()
    expect(f.engineering.readiness).toMatchObject({available:true,sourceProtocol:'assistant-delivery/work-item-engineering-context/v1',runProtocol:'assistant-growth/source-run/v2'})
    if(process.platform==='linux') {
      expect(f.engineering.generatorDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(f.engineering.sourceBinPins?.length).toBeGreaterThan(0)
      for(const pin of f.engineering.sourceBinPins!)expect(pin).toMatchObject({mode:'100755',blob:expect.stringMatching(/^[a-f0-9]{40}$/u)})
    }
    expect(f.supplier.requests.filter(request=>String(request.sessionId).startsWith('growth-')||String(request.sessionId).startsWith('creation-'))).toEqual([])
    expect(query(join(f.root,'control-plane/control.sqlite'),'SELECT id FROM source_jobs')).toEqual([])
    expect(query(join(f.root,'automations.sqlite'),'SELECT status,diagnostic_json FROM automation_runs')).toEqual([])
  },30000)

  test('a concrete failed task creates a genuinely built and independently exercised tool used by the next owner Agent with one approval',async()=>{
    const f=await workItemEngineeringFixture({replyEnabled:true}),source=await failedSource(f,true)
    await f.mountEngineering();const {job,alias}=await adopted(f)
    const prepared=f.ctx.pluginControlPlane.inspectPreparedCreation(job.planId!)
    expect(prepared.protocol).toBe('dsh-prepared-creation/v2')
    if(prepared.protocol!=='dsh-prepared-creation/v2')throw new Error('new engineering context required')
    expect(prepared.source.protocol).toBe('assistant-delivery/work-item-engineering-context/v1')
    const objective=JSON.parse(prepared.source.objective)
    expect(objective.inputs.map((input:{itemId:string;text:string})=>({itemId:input.itemId,text:input.text}))).toEqual([{itemId:source.rootItemId,text:f.supplier.objective},{itemId:source.itemId,text:source.childText}])
    expect(prepared.source.manifest.nodes.map(node=>node.itemId)).toEqual([source.rootItemId,source.itemId])
    expect(prepared.artifact.subarray(0,2)).toEqual(Buffer.from([0x1f,0x8b]))
    expect(createHash('sha256').update(prepared.artifact).digest('hex')).toBe(prepared.plan.preparedEvidence!.pack.sha256)
    const certificate=f.ctx.pluginControlPlane.inspectVerifiedCreation(job.planId!)!
    const policy=f.controlConfig()!.creationVerifications!
    expect(verifyPluginCreationVerificationCertificate(certificate,policy.authority,policy.publicKey)).toBe(true)
    expect(certificate.sessions.contract).not.toBe(certificate.sessions.sourceReview)
    expect(certificate.observations).toHaveLength(3)
    expect(f.engineering.heldoutCreatedAt).toBeGreaterThanOrEqual(f.engineering.candidateFrozenAt!)
    expect(prepared.job.intent.creation?.growthRun).toMatchObject({protocol:'assistant-growth/source-run/v2',source:{itemId:source.itemId,objectiveStatus:'not-achieved'}})
    const secret=String((f.engineering.heldout![0] as {arguments:{text:string}}).arguments.text)
    const author=f.supplier.requests.filter(r=>r.tools?.some(t=>t.name==='plugin_source_gaps'))
    expect(author).toHaveLength(4)
    for(const call of author) {expect(JSON.stringify(call.messages)).not.toContain(secret);expect(JSON.stringify({system:call.system,messages:call.messages})).toContain(source.childText!)}
    const review=f.supplier.requests.filter(call=>String(call.sessionId).startsWith('creation-'))
    expect(review).toHaveLength(2)
    for(const call of review) expect(JSON.stringify(call.messages)).toContain(source.childText!)
    expect(f.ownerApprovals).toEqual([]) // Background author tools never ask this foreground transport.
    const value=randomUUID(),called=await f.invokeOwner(alias,`#ignore=this is a later corrected requirement\nz=last\na=值=${value}`)
    expect(called.approvals).toEqual([expect.objectContaining({matched:true,outcome:'allowed-once',request:expect.objectContaining({toolName:alias})})])
    expect(called.events.filter(event=>event.type==='approval/decided').map(event=>event.data)).toEqual([expect.objectContaining({outcome:'allowed-once'})])
    expect(called.result.isError,JSON.stringify(called.result.content)).toBe(false)
    const payload=JSON.parse(called.result.content.filter(block=>block.type==='text').map(block=>block.text).join(''))
    expect(payload.value).toEqual({a:'值='+value,z:'last'})
    const calls=query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT status,job_id,tool_alias,foreground_json FROM calls')
    expect(calls).toEqual([expect.objectContaining({status:'completed',job_id:expect.any(String),tool_alias:alias})])
    expect(JSON.parse(String(calls[0]!.foreground_json))).toMatchObject({protocol:'assistant-delivery/foreground-tool-call/v1',task:{sessionId:called.sessionId},call:{toolName:alias}})
    const ownerRequests=f.supplier.requests.filter(request=>String(request.sessionId)===called.sessionId)
    expect(ownerRequests.length).toBeGreaterThan(0)
    for(const request of ownerRequests) expect(request.tools?.map(tool=>tool.name)).toContain(alias)
  },adoptionScenarioTimeout)

  test('a successful native build can still fail private held-out behavior and never adopt',async()=>{
    const f=await workItemEngineeringFixture({brokenCandidate:true});await failedSource(f);await f.mountEngineering()
    const job=await sourceJob(f)
    await vi.waitFor(()=>expect(f.ctx.pluginControlPlane.inspectCreationVerification(job.planId!)?.status).toBe('rejected'),{timeout:180000})
    const prepared=await f.saveNativeEvidence(job.planId!)
    const evidence=prepared.plan.preparedEvidence!
    if(evidence.schemaVersion===3) expect(evidence.checks).toContain('repository-pnpm-check')
    else if(evidence.schemaVersion===2) expect(evidence.checks).toEqual(['semantic-typecheck','js-declaration-emit','host-safe-pack'])
    else throw new Error('this native suite must not accept Docker or invented build evidence')
    // Mac compile/emit/pack is not candidate self-test execution. Linux's
    // genuine repository pnpm check includes the supplied ordinary self-test.
    expect(f.ctx.pluginControlPlane.inspectVerifiedCreation(job.planId!)).toBeUndefined()
    expect(f.ctx.tools.schemas().filter(t=>t.name.startsWith('evolved_owner_'))).toEqual([])
    expect(query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT * FROM adoptions')).toEqual([])
    expect(f.supplier.requests.filter(r=>String(r.sessionId).startsWith('creation-contract-'))).toHaveLength(1)
    expect(f.supplier.requests.filter(r=>String(r.sessionId).startsWith('creation-source-'))).toHaveLength(0)
  },300000)

  test('a correction and subsequent withdrawal fence the adopted alias without paying for another author or review',async()=>{
    const f=await workItemEngineeringFixture(),source=await failedSource(f);await f.mountEngineering();const {alias}=await adopted(f)
    await f.ctx.assistantAutomations.whenIdle();const before=counts(f),beforeActivity=activity(f)
    await revise(f,source.providerMessageId,'/feedback correct 1 not-achieved achieved','engineering-correct')
    const corrected=await f.invokeOwner(alias,'a=should-not-execute')
    expect(corrected.result.isError).toBe(true)
    await revise(f,source.providerMessageId,'/feedback withdraw 2 achieved','engineering-withdraw')
    await f.remountEngineering()
    expect(f.ctx.tools.schemas().filter(t=>t.name===alias)).toEqual([])
    await f.ctx.assistantAutomations.whenIdle();const after=counts(f)
    expect(after.paid).toBe(before.paid)
    expectOnlyNewScanReservations(f,beforeActivity,activity(f))
    expect(query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT * FROM calls')).toEqual([])
  },adoptionScenarioTimeout)

  test('a lost adoption ACK preserves the committed journal through cold remount without another paid generation',async()=>{
    const original=CreationCapabilityRuntime.prototype.adopt
    let dropped=false
    vi.spyOn(CreationCapabilityRuntime.prototype,'adopt').mockImplementation(async function(this:CreationCapabilityRuntime,planId,signal){
      await original.call(this,planId,signal)
      if(!dropped){dropped=true;throw new Error('injected transport ACK loss after real adoption commit')}
    })
    const f=await workItemEngineeringFixture();await failedSource(f);await f.mountEngineering();const {job,alias}=await adopted(f)
    expect(dropped).toBe(true)
    expect(query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT plan_id,status FROM adoptions')).toEqual([{plan_id:job.planId,status:'active'}])
    await vi.waitFor(()=>{
      const runs=query(join(f.root,'automations.sqlite'),'SELECT id,automation_id,status,diagnostic_json FROM automation_runs')
        .map(row=>({...row,diagnostic:JSON.parse(String(row.diagnostic_json)) as {failureCode:string}}))
        .filter(row=>['source-job-rejected','source-continuation-rejected','source-continuation-unsettled'].includes(row.diagnostic.failureCode))
      expect(runs).toEqual([expect.objectContaining({status:'unknown'})])
      f.engineering.ackHostRuns=runs
    },{timeout:15000})
    // ACK loss occurs after the real adoption commit. This proves committed
    // journal persistence, not recovery of an unknown adoption transaction.
    await f.ctx.assistantAutomations.whenIdle();const before=counts(f),beforeActivity=activity(f)
    await f.stopEngineering();await f.remountEngineering()
    await vi.waitFor(()=>expect(f.ctx.tools.schemas().some(t=>t.name===alias)).toBe(true),{timeout:30000})
    await f.ctx.assistantAutomations.whenIdle();const after=counts(f)
    expect(after.paid).toBe(before.paid)
    expect(after.authority).toEqual(before.authority)
    expect(after.adoptions).toEqual(before.adoptions)
    expectOnlyNewScanReservations(f,beforeActivity,activity(f))
    const called=await f.invokeOwner(alias,'b=after\na=restart')
    expect(called.approvals).toEqual([expect.objectContaining({matched:true,outcome:'allowed-once'})])
    expect(called.result.isError).toBe(false)
    expect(query(join(f.root,'control-plane/creation-adoptions.sqlite'),'SELECT DISTINCT plan_id FROM calls')).toEqual(before.adoptions.map(row=>({plan_id:row.plan_id})))
  },adoptionScenarioTimeout)
})
