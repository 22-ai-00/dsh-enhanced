import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedConfig } from './config.js'
import { CONTINUATION_OWNER, continuationItemBasis, parseContinuationActivation, type ContinuationProductionProof } from './continuation-contract.js'
import { continuationDigest } from './continuation-record.js'
import { DIAGNOSIS_OWNER, diagnosisPlanMatchesItem } from './diagnosis-contract.js'
import type { OwnerWorkItemFeedbackProof, WorkItemOwnerFeedbackTargets } from './feedback-targets.js'
import type { PeerOwnerRouteReceipt } from './peers.js'
import { isReplyContinuationPlan, parseStoredContinuationPlan } from './reply-contract.js'
import type { WorkItemStore } from './store.js'
import { OPEN_STATES, WorkItemError, type WorkItemRecord } from './types.js'

export interface EngineeringReportRef {
  readonly itemId:string;readonly revision:number;readonly digest:string;readonly fullTextDigest:string;readonly fullBytes:number
  readonly status:'progress'|'waiting'|'ready'|'blocked'|'failed';readonly truncated:boolean
}
export interface EngineeringNode {
  readonly itemId:string
  readonly planProtocol:'assistant-work-items/foreground-diagnosis-plan/v1'|'assistant-work-items/owner-continuation-plan/v1'|'assistant-work-items/owner-continuation-plan/v2'
  readonly planDigest:string
  readonly input:Readonly<{kind:'foreground';inboxId:string;sourceDigest:string;executionRef:string;completionSequence:number;
    binding:Readonly<{id:string;version:number;generation:number}>}>
    |Readonly<{kind:'continuation';sourceDigest:string;inputSha256:string;inputBytes:number;replyId?:string}>
  readonly parent:Readonly<{itemId:string;rootItemId:string;report:Readonly<EngineeringReportRef>|null;outcomeRevision:number|null;productionDigest:string}>|null
}
export interface WorkItemEngineeringMaterial {
  readonly protocol:'assistant-work-items/engineering-material/v1'
  readonly itemId:string;readonly rootItemId:string;readonly feedbackProofDigest:string
  readonly nodes:readonly Readonly<EngineeringNode>[]
  readonly continuationInputs:readonly Readonly<{itemId:string;text:string;fullTextDigest:string;fullBytes:number}>[]
  readonly parentReports:readonly Readonly<{itemId:string;revision:number;text:string;fullTextDigest:string;fullBytes:number}>[]
  readonly materialDigest:string
}
export const MAX_ENGINEERING_PARENT_LINKS=32
export const MAX_ENGINEERING_INPUT_BYTES=16384
export const MAX_ENGINEERING_REPORT_BYTES=262144
export const MAX_ENGINEERING_MATERIAL_BYTES=524288
const HEX=/^[a-f0-9]{64}$/u
function reject(message:string):never {throw new WorkItemError('source-rejected',`engineering context ${message}`)}
function positive(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0}
function identity(value:unknown,maximum=512):value is string {
  return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=maximum&&value.trim()===value&&!/\p{Cc}/u.test(value)
    &&Buffer.from(value,'utf8').toString('utf8')===value
}
function exactText(text:unknown,maximum:number,nonblank=false):string {
  if(typeof text!=='string'||Buffer.byteLength(text)>maximum||Buffer.from(text,'utf8').toString('utf8')!==text
    ||nonblank&&text.trim().length===0)reject('raw UTF-8 text is unavailable or exceeds its bound')
  return text
}
function freeze<T>(value:T):Readonly<T> {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value)}
  return value
}
function supplier(value:{provider:string;model:string;reasoningEffort?:string}) {
  if(!identity(value.provider,4096)||!identity(value.model,4096)
    ||Object.hasOwn(value,'reasoningEffort')&&!identity(value.reasoningEffort,4096))reject('supplier is malformed')
  return{provider:value.provider,model:value.model,...(Object.hasOwn(value,'reasoningEffort')?{reasoningEffort:value.reasoningEffort!}:{})}
}
function itemMatchesOwner(item:WorkItemRecord,proof:OwnerWorkItemFeedbackProof,owner:PeerOwnerRouteReceipt):void {
  if(item.observed||OPEN_STATES.includes(item.state)||item.owner.workspace!==item.scope.workspace||item.owner.agentPreset!==item.scope.preset
    ||item.sourceId!==proof.sourceId||item.scope.workspace!==proof.scope.workspace||item.scope.preset!==proof.scope.preset
    ||item.scope.ownerRouteId!==proof.owner.ownerRouteId||item.scope.principalId!==proof.owner.principalId
    ||item.owner.principalRecordId!==proof.owner.principalRecordId||item.owner.principalVersion!==proof.owner.principalVersion
    ||!identity(item.id,256)||!identity(item.originBindingId,256)||!positive(item.owner.generation)||!positive(item.owner.bindingVersion)
    ||!positive(owner.generation)||!positive(owner.bindingVersion)||item.owner.generation>owner.generation
    ||item.owner.generation===owner.generation&&item.owner.bindingVersion!==owner.bindingVersion)reject('item owner or binding lineage differs')
}
function parentLineage(parent:WorkItemRecord,child:WorkItemRecord):void {
  if(parent.owner.generation>child.owner.generation
    ||parent.owner.generation===child.owner.generation&&(parent.owner.bindingVersion!==child.owner.bindingVersion||parent.originBindingId!==child.originBindingId)) {
    reject('parent binding lineage regressed')
  }
}
function reportSnapshot(store:WorkItemStore,itemId:string,revision:number):Readonly<{ref:EngineeringReportRef;body:WorkItemEngineeringMaterial['parentReports'][number];fingerprint:string}> {
  if(!positive(revision))reject('report cutoff is invalid')
  const report=store.feedbackReportByRevision(itemId,revision)
  if(!report||report.itemId!==itemId||report.revision!==revision||!positive(report.recordedAt))reject('sealed report cutoff is missing')
  const text=exactText(report.summary,65536),fullTextDigest=continuationDigest(text),fullBytes=Buffer.byteLength(text)
  const immutable={protocol:'assistant-work-items/engineering-report/v1',itemId,revision,status:report.status,text,
    truncated:report.truncated,artifactPaths:report.artifactPaths,idempotencyKey:report.idempotencyKey,deliveryKey:report.deliveryKey,recordedAt:report.recordedAt}
  const digest=acceptanceDigest(immutable)
  return{ref:{itemId,revision,digest,fullTextDigest,fullBytes,status:report.status,truncated:report.truncated},
    body:{itemId,revision,text,fullTextDigest,fullBytes},fingerprint:digest}
}
interface ChainEntry {
  readonly item:WorkItemRecord;readonly node:EngineeringNode;readonly planSupplier:ReturnType<typeof supplier>
  readonly producer:Readonly<{owner:string;automationId:string;definitionHash:string;definitionVersion:number}>
  readonly parentProduction?:ContinuationProductionProof
  readonly replySupplier?:Readonly<{kind:string;itemId:string;planDigest:string;production:ContinuationProductionProof}>
  readonly replyTargetItemId?:string
  readonly input?:WorkItemEngineeringMaterial['continuationInputs'][number]
  readonly selectedReport?:ReturnType<typeof reportSnapshot>
  readonly fingerprint:string
}
interface Snapshot {readonly material:Readonly<WorkItemEngineeringMaterial>;readonly fingerprint:string}

/** Pure local chain reader. Delivery alone resolves the root Inbox and each
 * reply envelope; report text never substitutes for authenticated owner input. */
function readChain(store:WorkItemStore,proof:Readonly<OwnerWorkItemFeedbackProof>,owner:Readonly<PeerOwnerRouteReceipt>):Snapshot {
  const reverse:ChainEntry[]=[],seen=new Set<string>();let itemId=proof.itemId,totalInputs=0,totalReports=0
  for(;;){
    if(seen.has(itemId)||reverse.length>MAX_ENGINEERING_PARENT_LINKS)reject('parent chain is cyclic or exceeds 32 links')
    seen.add(itemId)
    const item=store.findItemById(itemId)
    if(!item)reject('ancestor is missing')
    itemMatchesOwner(item,proof,owner)
    const record=store.getContinuation(itemId)
    if(!record){
      const plan=store.readDiagnosisPlan(itemId)
      if(!plan||!diagnosisPlanMatchesItem(plan,item)||plan.worker.owner!==DIAGNOSIS_OWNER||plan.worker.automationId!==item.workerAutomationId
        ||plan.source.owner.principalRecordId!==item.owner.principalRecordId||plan.source.owner.principalVersion!==item.owner.principalVersion
        ||plan.source.binding.id!==item.originBindingId||plan.source.binding.version!==item.owner.bindingVersion||plan.source.binding.generation!==item.owner.generation
        ||!identity(plan.source.inboxId,256)||plan.source.executionRef!==plan.source.inboxId||!HEX.test(plan.source.sourceDigest)
        ||!positive(plan.source.completionSequence)||!identity(plan.source.binding.sessionId,512)
        ||!HEX.test(plan.worker.definitionHash)||!positive(plan.worker.definitionVersion))reject('root is not a sealed owner diagnosis')
      const planDigest=continuationDigest(acceptanceCanonicalJson(plan)),node:EngineeringNode={itemId,planProtocol:plan.protocol,planDigest,
        input:{kind:'foreground',inboxId:plan.source.inboxId,sourceDigest:plan.source.sourceDigest,executionRef:plan.source.executionRef,
          completionSequence:plan.source.completionSequence,binding:{id:plan.source.binding.id,version:plan.source.binding.version,generation:plan.source.binding.generation}},parent:null}
      reverse.push({item,node,planSupplier:supplier(plan.contract),producer:{owner:DIAGNOSIS_OWNER,automationId:item.workerAutomationId,
        definitionHash:plan.worker.definitionHash,definitionVersion:plan.worker.definitionVersion},fingerprint:acceptanceDigest({item:plan.item,planDigest})})
      break
    }
    const plan=parseStoredContinuationPlan(record.planJson)
    // v1's input hash did not retain a verifiable Inbox/attachment locator.
    // The new engineering protocol abstains rather than guessing text-only.
    if(!isReplyContinuationPlan(plan))reject('v1 continuation has no complete text-only source proof')
    if(acceptanceCanonicalJson(plan.item)!==acceptanceCanonicalJson(continuationItemBasis(item))
      ||record.itemId!==item.id||record.parentItemId!==plan.parent.itemId||record.rootItemId!==plan.parent.rootItemId
      ||record.parentReportRevision!==plan.parent.reportRevision||record.parentOutcomeRevision!==plan.parent.outcomeRevision
      ||record.sourceDigest!==plan.source.digest||record.inputSha256!==plan.source.inputSha256||record.inputBytes!==plan.source.inputBytes
      ||record.createdAt!==item.createdAt||!HEX.test(record.planDigest))reject('continuation seal or cutoff differs')
    const activation=parseContinuationActivation(plan.activation),reply=plan.source.origin.reply,replySupplier=plan.source.origin.supplier
    if(activation.stage!=='established'||activation.ownerLineage.authorityId!==item.scope.ownerRouteId
      ||activation.ownerLineage.principalId!==item.scope.principalId||activation.ownerLineage.principalRecordId!==item.owner.principalRecordId
      ||activation.ownerLineage.principalVersion!==item.owner.principalVersion||activation.ownerLineage.workspace!==item.scope.workspace
      ||activation.ownerLineage.agentPreset!==item.scope.preset||!identity(item.workerAutomationId,256))reject('continuation activation owner differs')
    const sourceText=exactText(record.inputText,MAX_ENGINEERING_INPUT_BYTES,true),bytes=Buffer.byteLength(sourceText)
    totalInputs+=bytes;if(totalInputs>MAX_ENGINEERING_INPUT_BYTES)reject('continuation inputs exceed 16384 bytes')
    if(reply.protocol!=='assistant-delivery/work-item-reply/v1'||!identity(reply.id,512)||reply.sourceDigest!==record.sourceDigest
      ||reply.inputSha256!==record.inputSha256||reply.inputBytes!==record.inputBytes||reply.inputSha256!==continuationDigest(sourceText)
      ||reply.binding.id!==item.originBindingId||reply.binding.version!==item.owner.bindingVersion||reply.binding.generation!==item.owner.generation
      ||reply.scope.workspace!==item.scope.workspace||reply.scope.preset!==item.scope.preset||reply.principalId!==item.scope.principalId
      ||reply.owner.principalRecordId!==item.owner.principalRecordId||reply.owner.principalVersion!==item.owner.principalVersion
      ||reply.target.streamId!==record.rootItemId||!identity(reply.target.itemId,256)||!positive(reply.target.reportRevision)||!HEX.test(reply.target.reportDigest)
      ||replySupplier.itemId!==record.parentItemId||acceptanceCanonicalJson(replySupplier.production)!==acceptanceCanonicalJson(plan.parent.production)
      ||acceptanceCanonicalJson(supplier(plan.contract))!==acceptanceCanonicalJson(plan.source.modelSelection))reject('reply input or supplier seal differs')
    const selected=record.parentReportRevision===null?undefined:reportSnapshot(store,record.parentItemId,record.parentReportRevision)
    if(selected){totalReports+=selected.body.fullBytes;if(totalReports>MAX_ENGINEERING_REPORT_BYTES)reject('parent reports exceed 262144 bytes')}
    let outcomeFingerprint:string|null=null
    if(record.parentOutcomeRevision!==null){
      const outcome=store.continuationParentOutcomes(itemId,record.parentOutcomeRevision-1,1)[0]
      if(!outcome||outcome.itemId!==record.parentItemId||outcome.revision!==record.parentOutcomeRevision)reject('sealed outcome cutoff is missing')
      outcomeFingerprint=acceptanceDigest(outcome)
    }
    const parentProduction=plan.parent.production
    const node:EngineeringNode={itemId,planProtocol:plan.protocol,planDigest:record.planDigest,
      input:{kind:'continuation',sourceDigest:record.sourceDigest,inputSha256:record.inputSha256,inputBytes:record.inputBytes,replyId:reply.id},
      parent:{itemId:record.parentItemId,rootItemId:record.rootItemId,report:selected?.ref??null,outcomeRevision:record.parentOutcomeRevision,
        productionDigest:acceptanceDigest(parentProduction)}}
    reverse.push({item,node,planSupplier:supplier(plan.contract),producer:{owner:CONTINUATION_OWNER,automationId:item.workerAutomationId,
      definitionHash:activation.definitionHash,definitionVersion:activation.definitionVersion},parentProduction,replySupplier,
      replyTargetItemId:reply.target.itemId,input:{itemId,text:sourceText,fullTextDigest:continuationDigest(sourceText),fullBytes:bytes},...(selected?{selectedReport:selected}:{}),
      fingerprint:acceptanceDigest({item:plan.item,planDigest:record.planDigest,inputSha256:record.inputSha256,
        parentReport:selected?.fingerprint??null,parentOutcome:outcomeFingerprint})})
    itemId=record.parentItemId
  }
  const chain=reverse.reverse(),rootItemId=chain[0]!.item.id
  for(let index=1;index<chain.length;index++){
    const entry=chain[index]!,parent=chain[index-1]!,production=entry.parentProduction!,link=entry.node.parent!
    parentLineage(parent.item,entry.item)
    if(link.itemId!==parent.item.id||link.rootItemId!==rootItemId||entry.replySupplier!.planDigest!==parent.node.planDigest
      ||entry.replySupplier!.kind!==(parent.node.parent===null?'diagnosis-plan':'continuation-plan')
      ||acceptanceCanonicalJson(entry.planSupplier)!==acceptanceCanonicalJson(parent.planSupplier)
      ||!chain.slice(0,index).some(ancestor=>ancestor.item.id===entry.replyTargetItemId)
      ||production.protocol!=='assistant-automations/production-occurrence/v1'||production.executionMode!=='production'
      ||!['succeeded','failed','cancelled','timed_out'].includes(production.status)||production.quiescent!==true
      ||production.budgetSettlementState!=='finalized'||!positive(production.completedAt)
      ||!identity(production.runId,512)||!identity(production.occurrenceId,512)||!identity(production.taskId,512)||!identity(production.attemptId,512)
      ||production.automationId!==parent.producer.automationId||production.immutableContext.state!=='verified'
      ||production.immutableContext.owner!==parent.producer.owner||production.immutableContext.definitionHash!==parent.producer.definitionHash
      ||production.immutableContext.definitionVersion!==parent.producer.definitionVersion
      ||production.immutableContext.scope.workspace!==proof.scope.workspace||production.immutableContext.scope.agentPreset!==proof.scope.preset)reject('parent chain production or supplier differs')
    if(link.report!==null&&link.report.status!=='progress'){
      const binding=store.diagnosisReportOccurrence(parent.item.id,link.report.revision)
      if(binding.occurrenceId!==production.occurrenceId||binding.status!==link.report.status)reject('parent report production occurrence differs')
    }
  }
  const leaf=chain.at(-1)!
  if(leaf.node.planDigest!==proof.planDigest||acceptanceCanonicalJson(leaf.planSupplier)!==acceptanceCanonicalJson(proof.supplier))reject('leaf feedback proof differs')
  const unsigned={protocol:'assistant-work-items/engineering-material/v1' as const,itemId:proof.itemId,rootItemId,feedbackProofDigest:proof.proofDigest,
    nodes:chain.map(entry=>entry.node),continuationInputs:chain.flatMap(entry=>entry.input?[entry.input]:[]),
    parentReports:chain.flatMap(entry=>entry.selectedReport?[entry.selectedReport.body]:[])}
  const material={...unsigned,materialDigest:acceptanceDigest(unsigned)}
  if(Buffer.byteLength(acceptanceCanonicalJson(material))>MAX_ENGINEERING_MATERIAL_BYTES)reject('material exceeds 524288 bytes')
  return{material:freeze(material),fingerprint:acceptanceDigest(chain.map(entry=>entry.fingerprint))}
}

export interface WorkItemEngineeringTargetDependencies {
  readonly config:NormalizedConfig
  readonly store:()=>WorkItemStore|undefined
  readonly feedback:()=>WorkItemOwnerFeedbackTargets|undefined
  readonly current:()=>boolean
}
interface EngineeringCapability {
  readonly feedbackCapability:unknown;readonly feedbackProofDigest:string;readonly materialDigest:string;readonly fingerprint:string
  readonly feedback:WorkItemOwnerFeedbackTargets;readonly store:WorkItemStore;readonly config:NormalizedConfig;readonly configDigest:string
}
/** Separate ephemeral authority: no old feedback or Memory capability is
 * upgraded into engineering-source authority merely by installing this API. */
export class WorkItemEngineeringTargets {
  #closed=false
  #capabilities=new WeakMap<object,EngineeringCapability>()
  constructor(private readonly dependencies:WorkItemEngineeringTargetDependencies){}
  private resources(){
    const config=this.dependencies.config,store=this.dependencies.store(),feedback=this.dependencies.feedback()
    if(this.#closed||!this.dependencies.current()||!store||store.closed||!feedback)throw new WorkItemError('missing-dependency','engineering source reader is unavailable')
    return{config,configDigest:acceptanceDigest(config),store,feedback}
  }
  issue(feedbackCapability:unknown):unknown|undefined {
    try {
      const frame=this.resources()
      return frame.feedback.withTargetsFence([feedbackCapability],proofs=>{
        const proof=proofs[0],owner=frame.feedback.engineeringFrameOwner(),current=this.resources()
        if(!proof||!owner||current.store!==frame.store||current.feedback!==frame.feedback||current.config!==frame.config||current.configDigest!==frame.configDigest)return undefined
        const snapshot=readChain(frame.store,proof,owner),capability=Object.freeze(Object.create(null) as object)
        this.#capabilities.set(capability,{feedbackCapability,feedbackProofDigest:proof.proofDigest,materialDigest:snapshot.material.materialDigest,
          fingerprint:snapshot.fingerprint,...frame})
        return capability
      })
    } catch{return undefined}
  }
  resolve(capability:unknown):Readonly<WorkItemEngineeringMaterial>|undefined {
    try{return this.withTargetsFence([capability],materials=>materials[0])}catch{return undefined}
  }
  withTargetsFence<T>(capabilities:readonly unknown[],callback:(materials:readonly (Readonly<WorkItemEngineeringMaterial>|undefined)[])=>T):T {
    if(!Array.isArray(capabilities)||typeof callback!=='function')throw new WorkItemError('invalid-input','engineering target fence arguments are invalid')
    const descriptors=Object.getOwnPropertyDescriptors(capabilities) as unknown as Record<PropertyKey,PropertyDescriptor>,length=descriptors['length']?.value as unknown,input:unknown[]=[]
    if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>1000)throw new WorkItemError('invalid-input','engineering target fence supports at most 1000 capabilities')
    if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||key!=='length'&&!/^(?:0|[1-9][0-9]*)$/u.test(key)))throw new WorkItemError('invalid-input','engineering capabilities must be dense data')
    for(let index=0;index<length;index++){
      const descriptor=descriptors[String(index)]
      if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new WorkItemError('invalid-input','engineering capabilities must be dense data')
      input.push(descriptor.value)
    }
    const frame=this.resources(),ownership=this.#capabilities,records=input.map(value=>value&&typeof value==='object'?ownership.get(value):undefined)
    return frame.feedback.withTargetsFence(records.map(record=>record?.feedbackCapability),proofs=>{
      const owner=frame.feedback.engineeringFrameOwner(),current=this.resources()
      if(ownership!==this.#capabilities||current.store!==frame.store||current.feedback!==frame.feedback||current.config!==frame.config||current.configDigest!==frame.configDigest) {
        throw new WorkItemError('missing-dependency','engineering source generation changed')
      }
      const materials=records.map((record,index)=>{
        if(!record||!owner||record.feedback!==frame.feedback||record.store!==frame.store||record.config!==frame.config||record.configDigest!==frame.configDigest
          ||ownership.get(input[index] as object)!==record||proofs[index]?.proofDigest!==record.feedbackProofDigest)return undefined
        try {
          const snapshot=readChain(frame.store,proofs[index]!,owner)
          return snapshot.material.materialDigest===record.materialDigest&&snapshot.fingerprint===record.fingerprint?snapshot.material:undefined
        } catch{return undefined}
      })
      return callback(Object.freeze(materials))
    })
  }
  close():void{this.#closed=true;this.#capabilities=new WeakMap()}
}
