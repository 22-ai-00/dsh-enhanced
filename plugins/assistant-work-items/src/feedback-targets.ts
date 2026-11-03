import { symbols } from '@deepseek-ai/cordis'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { TrustedWorkItemOwnerFeedbackProof } from '@dsh-enhanced/assistant-evaluation'
import type { NormalizedConfig } from './config.js'
import { CONTINUATION_OWNER, continuationItemBasis, parseContinuationActivation } from './continuation-contract.js'
import { continuationDigest } from './continuation-record.js'
import { DIAGNOSIS_OWNER } from './diagnosis-contract.js'
import { isReplyContinuationPlan, parseStoredContinuationPlan } from './reply-contract.js'
import type { PeerAutomationsService, PeerDeliveryService, PeerOwnerRouteReceipt, WorkItemReplyConsumerRegistration, WorkItemReportTarget } from './peers.js'
import type { WorkItemStore } from './store.js'
import { OPEN_STATES, WorkItemError, type WorkItemNotification, type WorkItemRecord, type WorkItemReportRecord } from './types.js'

export type OwnerWorkItemFeedbackSelector=Readonly<{itemId:string;reportRevision:number;reportDigest:string}>
/** Structural SDK surface; the implementation checks this against Evaluation's
 * shared proof without requiring a new optional-peer export in published .d.ts. */
export interface OwnerWorkItemFeedbackProof {
  protocol:'assistant-work-items/owner-report-feedback/v1'
  itemId:string;reportRevision:number;reportDigest:string;sourceId:string;itemKind:string
  scope:Readonly<{workspace:string;preset:string}>
  owner:Readonly<{ownerRouteId:string;principalId:string;principalRecordId:string;principalVersion:number}>
  originBindingId:string
  production:Readonly<{automationId:string;occurrenceId:string;runId:string;definitionHash:string;definitionVersion:number;
    executionStatus:'succeeded'|'failed'|'timed-out'|'cancelled';completedAt:number;quiescent:true;budgetSettlementState:'finalized'}>
  supplier:Readonly<{provider:string;model:string;reasoningEffort?:string}>
  planDigest:string
  task:Readonly<{brief:string;briefTruncated:boolean}>
  report:Readonly<{status:'ready'|'blocked'|'failed';text:string;truncated:boolean;recordedAt:number}>
  proofDigest:string
}
type Supplier=OwnerWorkItemFeedbackProof['supplier']
const HEX=/^[a-f0-9]{64}$/u
function bounded(value:unknown,maximum:number):value is string {
  return typeof value==='string' && value.length>0 && value.trim()===value && Buffer.byteLength(value)<=maximum
    && !/\p{Cc}/u.test(value) && Buffer.from(value,'utf8').toString('utf8')===value
}
function positive(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0}
function peerIdentity(peer:object):unknown {return(peer as Record<symbol,unknown>)[symbols.original]??peer}
/** Snapshot foreign metadata before the final local fence. Accessors, custom
 * prototypes and cycles cannot execute late code while a proof is assembled. */
function inert<T>(value:T):T {
  const ancestors=new Set<object>()
  const inspect=(current:unknown,depth:number):void=>{
    if(current===null||typeof current==='string'||typeof current==='boolean'||typeof current==='number'&&Number.isFinite(current))return
    if(!current||typeof current!=='object'||depth>12||ancestors.has(current))throw new Error('invalid peer data')
    const array=Array.isArray(current),prototype=Object.getPrototypeOf(current)
    if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)throw new Error('invalid peer prototype')
    const descriptors=Object.getOwnPropertyDescriptors(current),keys=Reflect.ownKeys(descriptors)
    if(keys.length>256)throw new Error('peer data too large')
    ancestors.add(current)
    for(const key of keys) {
      if(typeof key!=='string')throw new Error('peer data symbols invalid')
      const descriptor=descriptors[key]!
      if(array&&key==='length')continue
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new Error('peer accessors invalid')
      inspect(descriptor.value,depth+1)
    }
    ancestors.delete(current)
  }
  inspect(value,0)
  const text=acceptanceCanonicalJson(value)
  if(Buffer.byteLength(text)>65536)throw new Error('peer metadata exceeds byte bound')
  return JSON.parse(text) as T
}
function freeze<T>(value:T):Readonly<T> {
  if(value&&typeof value==='object') {for(const child of Object.values(value))freeze(child);Object.freeze(value)}
  return value
}
function supplierOf(contract:{provider:string;model:string;reasoningEffort?:string}):Supplier {
  if(!bounded(contract.provider,4096)||!bounded(contract.model,4096)
    || Object.hasOwn(contract,'reasoningEffort')&&!bounded(contract.reasoningEffort,4096))throw new Error('invalid frozen supplier')
  return{provider:contract.provider,model:contract.model,...(Object.hasOwn(contract,'reasoningEffort')?{reasoningEffort:contract.reasoningEffort!}:{})}
}
interface SealedReport {
  readonly item:WorkItemRecord
  readonly report:WorkItemReportRecord & {status:'ready'|'blocked'|'failed'}
  readonly text:string;readonly brief:string;readonly streamId:string;readonly planDigest:string;readonly supplier:Supplier
  readonly producer:Readonly<{owner:string;automationId:string;definitionHash:string;definitionVersion:number}>
  readonly occurrenceId:string;readonly reportDigest:string;readonly fingerprint:string
}
/** Preserve the existing typed-report identity, including v1/v2 plan digest,
 * while excluding mutable outbox delivery bookkeeping. */
export function workItemReportDigest(item:WorkItemRecord,report:WorkItemReportRecord,text:string,planDigest:string):string {
  return acceptanceDigest({itemId:item.id,revision:report.revision,status:report.status,summary:text,truncated:report.truncated,
    artifactPaths:report.artifactPaths,deliveryKey:report.deliveryKey,recordedAt:report.recordedAt,planDigest})
}
function sealedReport(store:WorkItemStore,config:NormalizedConfig,itemId:string,revision:number):SealedReport|undefined {
  const scope=config.scope,item=store.findItemById(itemId),found=store.feedbackReportByRevision(itemId,revision),last=store.lastReport(itemId)
  if(!scope||!item||item.observed||OPEN_STATES.includes(item.state)||!found||!last||last.revision!==revision
    || !['ready','blocked','failed'].includes(found.status)||item.scope.workspace!==scope.workspace||item.scope.preset!==scope.preset
    || item.scope.ownerRouteId!==scope.ownerRouteId||item.scope.principalId!==scope.principalId||item.sourceId!==config.intakeSourceId
    || !bounded(item.id,256)||!bounded(item.sourceId,128)||!bounded(item.kind,64)||!bounded(item.originBindingId,256)
    || !bounded(scope.workspace,4096)||!bounded(scope.preset,128)||!bounded(scope.principalId,256)||!bounded(scope.ownerRouteId,256)
    || !bounded(item.owner.principalRecordId,256)||!positive(item.owner.principalVersion)||!positive(found.recordedAt))return undefined
  const record=store.getContinuation(item.id)
  let planDigest:string,streamId:string,supplier:Supplier,producer:SealedReport['producer']
  if(record) {
    const plan=parseStoredContinuationPlan(record.planJson)
    if(acceptanceCanonicalJson(plan.item)!==acceptanceCanonicalJson(continuationItemBasis(item))
      || plan.source.digest!==record.sourceDigest||plan.source.inputSha256!==record.inputSha256||plan.source.inputBytes!==record.inputBytes
      || plan.parent.itemId!==record.parentItemId||plan.parent.rootItemId!==record.rootItemId
      || plan.parent.reportRevision!==record.parentReportRevision||plan.parent.outcomeRevision!==record.parentOutcomeRevision)return undefined
    const activation=parseContinuationActivation(plan.activation)
    if(activation.stage!=='established'||activation.ownerLineage.receiptVersion!==2
      || activation.ownerLineage.authorityId!==item.scope.ownerRouteId||activation.ownerLineage.principalId!==item.scope.principalId
      || activation.ownerLineage.principalRecordId!==item.owner.principalRecordId||activation.ownerLineage.principalVersion!==item.owner.principalVersion
      || activation.ownerLineage.workspace!==item.scope.workspace||activation.ownerLineage.agentPreset!==item.scope.preset)return undefined
    supplier=supplierOf(plan.contract)
    if(acceptanceCanonicalJson(supplier)!==acceptanceCanonicalJson(plan.source.modelSelection))return undefined
    planDigest=record.planDigest;streamId=isReplyContinuationPlan(plan)?plan.source.origin.reply.target.streamId:item.id
    producer={owner:CONTINUATION_OWNER,automationId:item.workerAutomationId,definitionHash:activation.definitionHash,definitionVersion:activation.definitionVersion}
  } else {
    const plan=store.readDiagnosisPlan(item.id)
    if(!plan||plan.worker.owner!==DIAGNOSIS_OWNER||plan.worker.automationId!==item.workerAutomationId
      || plan.source.owner.principalRecordId!==item.owner.principalRecordId||plan.source.owner.principalVersion!==item.owner.principalVersion
      || plan.source.binding.id!==item.originBindingId||plan.source.binding.version!==item.owner.bindingVersion||plan.source.binding.generation!==item.owner.generation)return undefined
    supplier=supplierOf(plan.contract);planDigest=continuationDigest(acceptanceCanonicalJson(plan));streamId=item.id
    producer={owner:DIAGNOSIS_OWNER,automationId:item.workerAutomationId,definitionHash:plan.worker.definitionHash,definitionVersion:plan.worker.definitionVersion}
  }
  if(!HEX.test(planDigest)||!HEX.test(producer.definitionHash)||!positive(producer.definitionVersion)||!bounded(producer.automationId,256)||!bounded(streamId,256))return undefined
  const text=store.ownerRecallText(item.id,revision),brief=store.ownerRecallText(item.id)
  if(Buffer.byteLength(text)>65536||Buffer.byteLength(brief)>65536||Buffer.from(text,'utf8').toString('utf8')!==text||Buffer.from(brief,'utf8').toString('utf8')!==brief)return undefined
  const binding=store.diagnosisReportOccurrence(item.id,revision)
  if(binding.status!==found.status||!bounded(binding.occurrenceId,512))return undefined
  const report=found as SealedReport['report'],reportDigest=workItemReportDigest(item,report,text,planDigest)
  const immutableReport={itemId:item.id,revision:report.revision,status:report.status,text,truncated:report.truncated,artifactPaths:report.artifactPaths,
    idempotencyKey:report.idempotencyKey,deliveryKey:report.deliveryKey,recordedAt:report.recordedAt}
  const fingerprint=acceptanceDigest({item,report:immutableReport,brief,planDigest,supplier,producer,occurrenceId:binding.occurrenceId})
  return{item,report,text,brief,streamId,planDigest,supplier,producer,occurrenceId:binding.occurrenceId,reportDigest,fingerprint}
}
function selectorOf(value:unknown):OwnerWorkItemFeedbackSelector|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return undefined
  const fields=Object.getOwnPropertyDescriptors(value)
  if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!['itemId','reportRevision','reportDigest'].includes(key))
    || Object.keys(fields).length!==3||Object.values(fields).some(field=>!field.enumerable||!Object.hasOwn(field,'value')))return undefined
  const itemId=fields.itemId?.value as unknown,reportRevision=fields.reportRevision?.value as unknown,reportDigest=fields.reportDigest?.value as unknown
  if(!bounded(itemId,256)||!positive(reportRevision)||typeof reportDigest!=='string'||!HEX.test(reportDigest))return undefined
  return Object.freeze({itemId,reportRevision,reportDigest})
}
export interface WorkItemFeedbackTargetDependencies {
  readonly config:NormalizedConfig
  readonly store:()=>WorkItemStore|undefined
  readonly delivery:()=>PeerDeliveryService|undefined
  readonly automations:()=>PeerAutomationsService|undefined
  /** Pure local current-service/fiber generation check. */
  readonly current:()=>boolean
}
interface CapabilityRecord {readonly selector:OwnerWorkItemFeedbackSelector;readonly proofDigest:string;readonly fingerprint:string;readonly authorityHash:string;
  readonly deliveryIdentity:unknown;readonly automationsIdentity:unknown}
interface ReadResult {readonly proof:OwnerWorkItemFeedbackProof;readonly fingerprint:string;readonly authorityHash:string;
  readonly deliveryIdentity:unknown;readonly automationsIdentity:unknown}
/** Historical result reader. It never starts/reconciles an automation, checks
 * a live execution grant, reserves budget, or turns testimony into success. */
export class WorkItemOwnerFeedbackTargets {
  #closed=false
  #capabilities=new WeakMap<object,CapabilityRecord>()
  #engineeringFrameOwner:Readonly<PeerOwnerRouteReceipt>|undefined
  constructor(private readonly dependencies:WorkItemFeedbackTargetDependencies) {}
  private current():boolean {return!this.#closed&&this.dependencies.current()}
  /** Local-only metadata for an engineering callback already inside this
   * reader's writer frame. It never mints authority outside that frame. */
  engineeringFrameOwner():Readonly<PeerOwnerRouteReceipt>|undefined {return this.current()?this.#engineeringFrameOwner:undefined}
  inspectReport(input:Parameters<WorkItemReplyConsumerRegistration['inspectReport']>[0],notification:(item:WorkItemRecord,report:WorkItemReportRecord)=>WorkItemNotification):WorkItemReportTarget|undefined {
    try {
      const {config}=this.dependencies,store=this.dependencies.store()
      if(!config.ownerReportFeedback||!this.current()||!store||store.closed)return undefined
      const snapshot=sealedReport(store,config,input.itemId,input.reportRevision)
      if(!snapshot||snapshot.item.originBindingId!==input.bindingId||snapshot.report.deliveryKey!==input.idempotencyKey||input.format!=='markdown'
        || notification(snapshot.item,{...snapshot.report,summary:snapshot.text}).text!==input.text)return undefined
      const again=sealedReport(store,config,input.itemId,input.reportRevision)
      if(!again||again.fingerprint!==snapshot.fingerprint||!this.current()||store.closed)return undefined
      return freeze({protocol:'assistant-delivery/work-item-report/v1',itemId:snapshot.item.id,reportRevision:snapshot.report.revision,
        streamId:snapshot.streamId,reportDigest:snapshot.reportDigest,sourceId:snapshot.item.sourceId,
        scope:{workspace:snapshot.item.scope.workspace,preset:snapshot.item.scope.preset},
        owner:{principalRecordId:snapshot.item.owner.principalRecordId,principalVersion:snapshot.item.owner.principalVersion}})
    } catch{return undefined}
  }
  private read(selector:OwnerWorkItemFeedbackSelector):Readonly<ReadResult>|undefined {
    const {config}=this.dependencies,scope=config.scope,store=this.dependencies.store()
    if(!config.ownerReportFeedback||!scope||!config.ownerContinuation||!this.current()||!store||store.closed)return undefined
    const snapshot=sealedReport(store,config,selector.itemId,selector.reportRevision)
    if(!snapshot||snapshot.reportDigest!==selector.reportDigest)return undefined
    const delivery=this.dependencies.delivery(),automations=this.dependencies.automations()
    if(!delivery||!automations?.inspectProductionOccurrence)return undefined
    const deliveryIdentity=peerIdentity(delivery),automationsIdentity=peerIdentity(automations)
    const readOwner=():Readonly<PeerOwnerRouteReceipt>=>inert(delivery.validateOwnerRoute({authorityId:scope.ownerRouteId,principalId:scope.principalId,workspace:scope.workspace,agentPreset:scope.preset}))
    const validOwner=(owner:PeerOwnerRouteReceipt):boolean=>owner.receiptVersion===2&&owner.authorityId===scope.ownerRouteId&&owner.principalId===scope.principalId
      &&owner.workspace===scope.workspace&&owner.agentPreset===scope.preset&&bounded(owner.authorityHash,256)
      &&owner.principalRecordId===snapshot.item.owner.principalRecordId&&owner.principalVersion===snapshot.item.owner.principalVersion
      &&positive(owner.generation)&&positive(owner.bindingVersion)
    const owner=readOwner()
    if(!validOwner(owner))return undefined
    const observed=automations.inspectProductionOccurrence({automationId:snapshot.producer.automationId,occurrenceId:snapshot.occurrenceId,
      workspace:scope.workspace,agentPreset:scope.preset})
    const production=observed===undefined?undefined:inert(observed)
    if(!production||production.protocol!=='assistant-automations/production-occurrence/v1'||production.executionMode!=='production'
      ||production.automationId!==snapshot.producer.automationId||production.occurrenceId!==snapshot.occurrenceId||!bounded(production.runId,512)
      ||!bounded(production.taskId,512)||!bounded(production.attemptId,512)
      ||!positive(production.completedAt)||production.quiescent!==true||production.budgetSettlementState!=='finalized'
      ||production.immutableContext.state!=='verified'||production.immutableContext.owner!==snapshot.producer.owner
      ||production.immutableContext.definitionHash!==snapshot.producer.definitionHash||production.immutableContext.definitionVersion!==snapshot.producer.definitionVersion
      ||production.immutableContext.scope.workspace!==scope.workspace||production.immutableContext.scope.agentPreset!==scope.preset)return undefined
    const statuses={succeeded:'succeeded',failed:'failed',timed_out:'timed-out',cancelled:'cancelled'} as const
    if(!Object.hasOwn(statuses,production.status))return undefined
    const executionStatus=statuses[production.status]
    const currentOwner=readOwner()
    if(!validOwner(currentOwner)||acceptanceCanonicalJson(currentOwner)!==acceptanceCanonicalJson(owner))return undefined
    const currentDelivery=this.dependencies.delivery(),currentAutomations=this.dependencies.automations()
    if(!currentDelivery||!currentAutomations||peerIdentity(currentDelivery)!==deliveryIdentity||peerIdentity(currentAutomations)!==automationsIdentity)return undefined
    // Everything below is local: the last peer callback cannot replace the
    // report/plan, change its bytes, or dispose the current capability owner.
    const final=sealedReport(store,config,selector.itemId,selector.reportRevision)
    if(!final||final.fingerprint!==snapshot.fingerprint||!this.current()||store.closed)return undefined
    const unsigned={protocol:'assistant-work-items/owner-report-feedback/v1' as const,itemId:snapshot.item.id,reportRevision:snapshot.report.revision,
      reportDigest:snapshot.reportDigest,sourceId:snapshot.item.sourceId,itemKind:snapshot.item.kind,scope:{workspace:scope.workspace,preset:scope.preset},
      owner:{ownerRouteId:scope.ownerRouteId,principalId:scope.principalId,principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},
      originBindingId:snapshot.item.originBindingId,production:{automationId:production.automationId,occurrenceId:production.occurrenceId,runId:production.runId,
        definitionHash:production.immutableContext.definitionHash,definitionVersion:production.immutableContext.definitionVersion,
        executionStatus,completedAt:production.completedAt,quiescent:true as const,budgetSettlementState:'finalized' as const},supplier:snapshot.supplier,
      planDigest:snapshot.planDigest,task:{brief:snapshot.brief,briefTruncated:snapshot.item.briefTruncated},
      report:{status:snapshot.report.status,text:snapshot.text,truncated:snapshot.report.truncated,recordedAt:snapshot.report.recordedAt}}
    const proof:TrustedWorkItemOwnerFeedbackProof={...unsigned,proofDigest:acceptanceDigest(unsigned)}
    return{proof:freeze(proof),fingerprint:snapshot.fingerprint,authorityHash:owner.authorityHash,deliveryIdentity,automationsIdentity}
  }
  issue(input:unknown):unknown|undefined {
    try {
      const selector=selectorOf(input)
      if(!selector)return undefined
      const result=this.read(selector)
      if(!result)return undefined
      const capability=Object.freeze(Object.create(null) as object)
      this.#capabilities.set(capability,{selector,proofDigest:result.proof.proofDigest,fingerprint:result.fingerprint,authorityHash:result.authorityHash,
        deliveryIdentity:result.deliveryIdentity,automationsIdentity:result.automationsIdentity})
      return capability
    } catch{return undefined}
  }
  resolve(capability:unknown):Readonly<OwnerWorkItemFeedbackProof>|undefined {
    try {
      if(!capability||typeof capability!=='object'||!this.current())return undefined
      const issued=this.#capabilities.get(capability)
      if(!issued)return undefined
      const result=this.read(issued.selector)
      if(!result||result.proof.proofDigest!==issued.proofDigest||result.fingerprint!==issued.fingerprint||result.authorityHash!==issued.authorityHash
        ||result.deliveryIdentity!==issued.deliveryIdentity||result.automationsIdentity!==issued.automationsIdentity)return undefined
      return result.proof
    } catch{return undefined}
  }
  /** A group is validated as one source frame, rather than trusting A's cached
   * result after a later B producer callback. The last phase reads only this
   * owned ledger, configuration and local service identities. */
  withTargetsFence<T>(capabilities:readonly unknown[],callback:(proofs:readonly (Readonly<OwnerWorkItemFeedbackProof>|undefined)[])=>T):T {
    if(!Array.isArray(capabilities)||typeof callback!=='function')throw new WorkItemError('invalid-input','feedback target fence arguments are invalid')
    const descriptors=Object.getOwnPropertyDescriptors(capabilities) as unknown as Record<PropertyKey,PropertyDescriptor>
    const length=descriptors.length?.value as unknown
    if(!Number.isSafeInteger(length)||Number(length)<0||Number(length)>1000
      ||Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||key!=='length'&&!/^(?:0|[1-9][0-9]*)$/u.test(key))) {
      throw new WorkItemError('invalid-input','feedback target fence requires at most 1000 dense capabilities')
    }
    const input:unknown[]=[]
    for(let index=0;index<Number(length);index++) {
      const descriptor=descriptors[String(index)]
      if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new WorkItemError('invalid-input','feedback target fence capabilities must be data values')
      input.push(descriptor.value)
    }
    const config=this.dependencies.config,configurationDigest=acceptanceDigest(config),store=this.dependencies.store()
    if(!this.current()||!config.ownerReportFeedback||!store||store.closed)throw new WorkItemError('missing-dependency','feedback target source fence is unavailable')
    return store.withFeedbackSourceFence(()=>{
      const ownership=this.#capabilities
      const entries=input.map(capability=>{
        if(!capability||typeof capability!=='object')return undefined
        const issued=ownership.get(capability)
        return issued?{capability,issued}:undefined
      })
      const reads=new Map<object,Readonly<ReadResult>|undefined>()
      for(const entry of entries) {
        if(!entry||reads.has(entry.capability))continue
        try { reads.set(entry.capability,this.read(entry.issued.selector)) } catch { reads.set(entry.capability,undefined) }
      }
      // One final owner read belongs to the foreign-read phase. A later
      // source's callback may have changed the shared route after A was read;
      // never keep A's cached authority hash as the group authority.
      const ownerDelivery=this.dependencies.delivery(),scope=config.scope
      const ownerDeliveryIdentity=ownerDelivery?peerIdentity(ownerDelivery):undefined
      let owner:Readonly<PeerOwnerRouteReceipt>|undefined
      try {
        if(ownerDelivery&&scope)owner=inert(ownerDelivery.validateOwnerRoute({authorityId:scope.ownerRouteId,
          principalId:scope.principalId,workspace:scope.workspace,agentPreset:scope.preset}))
      } catch {owner=undefined}
      // These dependency accessors are owned ctx-local lookups, not producer
      // methods. Capture all identities before the final local source pass.
      const currentConfig=this.dependencies.config,currentStore=this.dependencies.store()
      const delivery=this.dependencies.delivery(),automations=this.dependencies.automations()
      const deliveryIdentity=delivery?peerIdentity(delivery):undefined,automationsIdentity=automations?peerIdentity(automations):undefined
      const currentConfigurationDigest=acceptanceDigest(currentConfig),active=this.current()
      if(!active||this.#capabilities!==ownership||currentStore!==store||store.closed||!delivery||!automations) {
        throw new WorkItemError('missing-dependency','feedback target source owner or store is no longer current')
      }
      const configurationCurrent=currentConfig===config&&currentConfigurationDigest===configurationDigest
      const proofs=entries.map(entry=>{
        if(!entry||!configurationCurrent||this.#capabilities.get(entry.capability)!==entry.issued)return undefined
        const result=reads.get(entry.capability),issued=entry.issued
        if(!result||result.proof.proofDigest!==issued.proofDigest||result.fingerprint!==issued.fingerprint
          ||result.authorityHash!==issued.authorityHash||result.deliveryIdentity!==issued.deliveryIdentity
          ||result.automationsIdentity!==issued.automationsIdentity||deliveryIdentity!==issued.deliveryIdentity
          ||automationsIdentity!==issued.automationsIdentity||ownerDeliveryIdentity!==deliveryIdentity
          ||!owner||owner.receiptVersion!==2||owner.authorityHash!==issued.authorityHash
          ||owner.authorityId!==result.proof.owner.ownerRouteId||owner.principalId!==result.proof.owner.principalId
          ||owner.principalRecordId!==result.proof.owner.principalRecordId||owner.principalVersion!==result.proof.owner.principalVersion
          ||owner.workspace!==result.proof.scope.workspace||owner.agentPreset!==result.proof.scope.preset)return undefined
        try {
          const final=sealedReport(store,config,issued.selector.itemId,issued.selector.reportRevision)
          return final&&final.fingerprint===issued.fingerprint&&final.reportDigest===issued.selector.reportDigest?result.proof:undefined
        } catch {return undefined}
      })
      // No producer, owner or lifecycle callback is invoked after this pass.
      const previousOwner=this.#engineeringFrameOwner
      this.#engineeringFrameOwner=owner===undefined?undefined:freeze(owner)
      try {return callback(Object.freeze(proofs))}
      finally {this.#engineeringFrameOwner=this.#closed?undefined:previousOwner}
    })
  }
  available():boolean {return this.current()&&this.dependencies.config.ownerReportFeedback===true&&this.dependencies.store()?.closed===false}
  close():void {this.#closed=true;this.#capabilities=new WeakMap();this.#engineeringFrameOwner=undefined}
}
