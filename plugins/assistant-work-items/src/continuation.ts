import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { NormalizedConfig } from './config.js'
import type { PeerAutomationsService, PeerDeliveryService, PeerOwnerRouteReceipt, PeerPolicyService, WorkItemReplySource } from './peers.js'
import type { WorkItemStore } from './store.js'
import { OPEN_STATES, type WorkItemRecord, type WorkItemReportStatus } from './types.js'
import { continuationDigest, continuationSourceKey, type WorkItemContinuationAdmission } from './continuation-record.js'
import {
  CONTINUATION_EXECUTOR, CONTINUATION_OWNER, CONTINUATION_PROMPT_VERSION, continuationCanonical,
  continuationConfigurationDigest, continuationDefinition, continuationDefinitionHash, continuationFail,
  continuationItemBasis, continuationOwnerLineage, continuationSchemas, createContinuationPlan, parseContinuationActivation,
  type ContinuationActivation, type ContinuationParent, type ContinuationProductionProof, type ContinuationSource,
} from './continuation-contract.js'
import { DIAGNOSIS_OWNER } from './diagnosis-contract.js'
import { createReplyContinuationPlan, immutableReply, isReplyContinuationPlan, parseStoredContinuationPlan,
  type ReplySupplierEvidence, type StoredContinuationPlan } from './reply-contract.js'

const ACTIVATION_KEY='continuation.activation/v1'
const PENDING_CURSOR_KEY='continuation.pending-cursor/v1'
export interface ContinuationHooks {
  readonly assertOwner:(item:WorkItemRecord)=>Readonly<PeerOwnerRouteReceipt>
  readonly assertMandate:(item:WorkItemRecord)=>void
  readonly wake:(item:WorkItemRecord)=>boolean
  /** Pure local registration/lifecycle check, never a Delivery call. */
  readonly isReplyConsumerCurrent?:()=>boolean
}
export interface ContinuationContextInput {
  readonly kind?:'input'|'parent-brief'|'parent-report'|'parent-outcome'
  readonly revision?:number
  readonly offset?:number
  readonly maxBytes?:number
}
interface Run {
  readonly input:HostAutomationExecutorInput; readonly itemId:string; readonly plan:StoredContinuationPlan
  readonly controller:AbortController
  phase:'before-claim'|'claimed'|'reported'
  reportRevision?:number; reportStatus?:WorkItemReportStatus
}
type ContinuationAutomations=PeerAutomationsService & {
  inspectProductionOccurrence?(input:{automationId:string;occurrenceId:string;workspace:string;agentPreset:string}):Readonly<ContinuationProductionProof>|undefined
}

/** A consumer of the existing Host execution service, with no additional loop or timer. */
export class WorkItemContinuation {
  readonly #controller=new AbortController()
  readonly #runs=new Map<string,Run>()
  #activation:Readonly<ContinuationActivation>|undefined
  #remove:(()=>void)|undefined
  #closed=false
  #waking=false
  #lastError:string|null=null
  constructor(readonly context:Context,readonly config:NormalizedConfig,readonly store:WorkItemStore,readonly hooks:ContinuationHooks) {}
  private automations():ContinuationAutomations {
    if(this.#closed || this.#controller.signal.aborted || this.store.closed) continuationFail('consumer disposed')
    const peer=this.context.get('assistantAutomations' as never) as ContinuationAutomations|undefined
    if(!peer || peer.hostAgentAuthorizationVersion?.()!==1 || typeof peer.runAgentForHostExecution!=='function'
      || typeof peer.registerHostExecutor!=='function' || typeof peer.reconcileSystem!=='function'
      || typeof peer.inspectSystemOwned!=='function' || typeof peer.inspectSystemOwnedActivation!=='function'
      || typeof peer.inspectProductionOccurrence!=='function') continuationFail('fenced Host peer unavailable')
    return peer
  }
  private schemas():readonly {name:string}[] {
    const allowed=this.config.ownerContinuation?.allowedTools
    if(!allowed) continuationFail('configuration unavailable')
    return continuationSchemas(this.context.tools.schemas().filter(schema=>allowed.includes(schema.name)),this.config)
  }
  private owner():Readonly<PeerOwnerRouteReceipt> {
    const scope=this.config.scope,settings=this.config.ownerContinuation
    if(!scope || !settings || !this.config.enabled || this.config.mode!=='active'
      || Date.now()>=Math.min(scope.expiresAt,settings.expiresAt)) continuationFail('authorization expired or disabled')
    const delivery=this.context.get('assistantDelivery' as never) as PeerDeliveryService|undefined
    if(!delivery?.validateOwnerRoute) continuationFail('owner route unavailable')
    const receipt=delivery.validateOwnerRoute({authorityId:scope.ownerRouteId,principalId:scope.principalId,workspace:scope.workspace,agentPreset:scope.preset})
    if(receipt.receiptVersion!==2 || receipt.authorityId!==scope.ownerRouteId || receipt.principalId!==scope.principalId
      || receipt.workspace!==scope.workspace || receipt.agentPreset!==scope.preset || !receipt.authorityHash
      || !receipt.principalRecordId || !Number.isSafeInteger(receipt.principalVersion) || receipt.principalVersion<1
      || !Number.isSafeInteger(receipt.generation) || receipt.generation<1 || !Number.isSafeInteger(receipt.bindingVersion) || receipt.bindingVersion<1) continuationFail('current owner differs')
    return receipt
  }
  start():void {
    if(this.#activation || this.#closed) continuationFail('activation already started or disposed')
    const settings=this.config.ownerContinuation,scope=this.config.scope
    if(!settings || !scope) continuationFail('explicit configuration required')
    const peer=this.automations(),receipt=this.owner(),schemas=this.schemas()
    const policy=this.context.get('assistantPolicy' as never) as PeerPolicyService|undefined
    if(policy?.authorize({subject:{kind:'background',id:this.config.intakeSourceId,workspace:scope.workspace,principal:scope.principalId},
      action:'admit',resource:{kind:'automation',id:settings.automationId},context:{initiator:'background'}},
    {idempotencyKey:`continuation-activation-admit:${this.config.intakeSourceId}:${settings.automationId}`}).effect!=='allow') continuationFail('activation admission denied')
    const configurationDigest=continuationConfigurationDigest(this.config,schemas)
    const catalogDigest=acceptanceDigest({protocol:CONTINUATION_PROMPT_VERSION,schemas})
    const prior=this.store.readCanonicalMeta(ACTIVATION_KEY)
    let activation:Readonly<ContinuationActivation>
    if(prior===undefined) {
      const nonce=randomBytes(32).toString('hex')
      activation=Object.freeze({protocol:'assistant-work-items/continuation-activation/v1',stage:'pending',configurationDigest,
        activationNonce:nonce,reconciliationKey:`continuation-${acceptanceDigest({configurationDigest,nonce})}`,
        definitionHash:continuationDefinitionHash(continuationDefinition(this.config,nonce,catalogDigest)),definitionVersion:1,
        catalogDigest,ownerLineage:continuationOwnerLineage(receipt)})
      this.store.setMeta(ACTIVATION_KEY,continuationCanonical(activation))
    } else activation=parseContinuationActivation(prior)
    if(activation.configurationDigest!==configurationDigest || activation.catalogDigest!==catalogDigest
      || acceptanceCanonicalJson(activation.ownerLineage)!==acceptanceCanonicalJson(continuationOwnerLineage(receipt))
      || activation.definitionHash!==continuationDefinitionHash(continuationDefinition(this.config,activation.activationNonce,catalogDigest))) continuationFail('activation configuration or owner changed')
    this.#activation=activation
    this.#remove=peer.registerHostExecutor!({descriptor:{executorId:CONTINUATION_EXECUTOR,contractVersion:1,catalogDigest},
      accepts:spec=>!this.#closed && spec.kind==='host' && spec.executorId===CONTINUATION_EXECUTOR && spec.executorContractVersion===1
        && spec.runbookId==='owner-continuation' && spec.runbookVersion===1 && spec.catalogDigest===catalogDigest
        && spec.activationNonce===activation.activationNonce && spec.ownerRouteId===scope.ownerRouteId
        && spec.targetScope.workspace===scope.workspace && spec.targetScope.preset===scope.preset,
      execute:input=>this.execute(input)})
    if(activation.stage==='pending') {
      let present=false
      try {peer.inspectSystemOwned!({owner:CONTINUATION_OWNER,automationId:settings.automationId});present=true}
      catch(error) {if(!(error && typeof error==='object' && 'code' in error && error.code==='not-found')) throw error}
      if(!present) peer.reconcileSystem!({owner:CONTINUATION_OWNER,automationId:settings.automationId,idempotencyKey:activation.reconciliationKey,
        definition:continuationDefinition(this.config,activation.activationNonce,catalogDigest),desiredStatus:'active'})
      this.assertActivation(activation)
      activation=Object.freeze({...activation,stage:'established'})
      this.store.setMeta(ACTIVATION_KEY,continuationCanonical(activation));this.#activation=activation
    } else this.assertActivation(activation)
    this.wakePending()
  }
  private assertActivation(expected=this.#activation):Readonly<ContinuationActivation> {
    if(!expected) continuationFail('activation unavailable')
    const peer=this.automations(),receipt=this.owner(),current=parseContinuationActivation(this.store.readCanonicalMeta(ACTIVATION_KEY))
    if(acceptanceCanonicalJson(current)!==acceptanceCanonicalJson(expected)
      || current.configurationDigest!==continuationConfigurationDigest(this.config,this.schemas())
      || acceptanceCanonicalJson(current.ownerLineage)!==acceptanceCanonicalJson(continuationOwnerLineage(receipt))) continuationFail('activation receipt changed')
    const input={owner:CONTINUATION_OWNER,automationId:this.config.ownerContinuation!.automationId}
    const state=peer.inspectSystemOwned!(input),binding=peer.inspectSystemOwnedActivation!(input)
    if(state.owner!==input.owner || state.automationId!==input.automationId || state.automationStatus!=='active'
      || state.definitionHash!==current.definitionHash || state.definitionVersion!==current.definitionVersion
      || !binding || binding.definitionHash!==current.definitionHash || binding.activationNonce!==current.activationNonce
      || binding.ownerRouteId!==this.config.scope!.ownerRouteId) continuationFail('worker paused, missing or changed')
    return current
  }
  private proof(item:WorkItemRecord,occurrenceId:string):Readonly<ContinuationProductionProof> {
    const input={automationId:item.workerAutomationId,occurrenceId,workspace:item.scope.workspace,agentPreset:item.scope.preset}
    const proof=this.automations().inspectProductionOccurrence!(input)
    const continuation=this.store.getContinuation(item.id)
    const budgetRequired=continuation!==undefined || item.workerAutomationId===this.config.ownerContinuation!.automationId
    if(!proof || proof.protocol!=='assistant-automations/production-occurrence/v1' || proof.automationId!==input.automationId
      || proof.occurrenceId!==input.occurrenceId || proof.executionMode!=='production' || !['succeeded','failed','cancelled','timed_out'].includes(proof.status)
      || proof.quiescent!==true || proof.budgetSettlementState!=='finalized' && (budgetRequired || proof.budgetSettlementState!=='not-required')
      || !Number.isSafeInteger(proof.completedAt) || proof.completedAt<1
      || proof.immutableContext.state!=='verified' || proof.immutableContext.scope.workspace!==input.workspace
      || proof.immutableContext.scope.agentPreset!==input.agentPreset) continuationFail('exact production termination unproven')
    if(continuation) {
      const plan=parseStoredContinuationPlan(continuation.planJson)
      if(acceptanceCanonicalJson(plan.item)!==acceptanceCanonicalJson(continuationItemBasis(item))
        || plan.source.digest!==continuation.sourceDigest || plan.source.inputSha256!==continuation.inputSha256
        || plan.source.inputBytes!==continuation.inputBytes || plan.parent.itemId!==continuation.parentItemId
        || plan.parent.rootItemId!==continuation.rootItemId || plan.parent.reportRevision!==continuation.parentReportRevision
        || plan.parent.outcomeRevision!==continuation.parentOutcomeRevision || plan.activation.stage!=='established'
        || proof.immutableContext.definitionHash!==plan.activation.definitionHash
        || proof.immutableContext.definitionVersion!==plan.activation.definitionVersion
        || proof.immutableContext.owner!==CONTINUATION_OWNER) continuationFail('production proof differs from frozen continuation')
    }
    return Object.freeze(JSON.parse(acceptanceCanonicalJson(proof)) as ContinuationProductionProof)
  }
  private parent(itemId:string):ContinuationParent {
    const item=this.store.findItemById(itemId),owner=this.owner(),scope=this.config.scope!
    if(!item || item.observed || OPEN_STATES.includes(item.state) || item.scope.principalId!==scope.principalId
      || ![this.config.workerAutomationId,this.config.ownerContinuation!.automationId].includes(item.workerAutomationId)
      || item.scope.ownerRouteId!==scope.ownerRouteId || item.scope.workspace!==scope.workspace || item.scope.preset!==scope.preset
      || item.owner.principalRecordId!==owner.principalRecordId || item.owner.principalVersion!==owner.principalVersion
      || item.owner.generation>owner.generation || item.owner.generation===owner.generation && item.owner.bindingVersion!==owner.bindingVersion) continuationFail('parent is not a terminal task of this owner')
    const report=this.store.lastReport(itemId)
    if(!report || !['ready','blocked','failed'].includes(report.status)) continuationFail('parent has no terminal report binding')
    const binding=this.store.diagnosisReportOccurrence(itemId,report.revision)
    const production=this.proof(item,binding.occurrenceId)
    const inherited=this.store.getContinuation(itemId)
    return Object.freeze({itemId,rootItemId:inherited?.rootItemId??itemId,reportRevision:report.revision,
      outcomeRevision:this.store.latestOutcome(itemId)?.revision??null,production})
  }
  prepare(parentItemId:string,source:ContinuationSource,assertCurrent:()=>void):WorkItemContinuationAdmission {
    assertCurrent()
    const activation=this.assertActivation(),parent=this.parent(parentItemId)
    // Snapshot caller objects before any further peer callback can mutate them.
    const frozenSource=JSON.parse(acceptanceCanonicalJson(source)) as ContinuationSource
    const sourceKey=continuationSourceKey(parentItemId,frozenSource.sourceDigest)
    assertCurrent()
    return Object.freeze({parentItemId,sourceDigest:frozenSource.sourceDigest,sourceKey,create:(item:WorkItemRecord)=>{
      assertCurrent()
      const currentParent=this.parent(parentItemId)
      if(acceptanceCanonicalJson(currentParent)!==acceptanceCanonicalJson(parent)) continuationFail('parent changed before admission')
      const plan=createContinuationPlan(item,frozenSource,parent,this.config,this.assertActivation(activation),this.schemas())
      const planJson=continuationCanonical(plan)
      assertCurrent()
      return Object.freeze({itemId:item.id,parentItemId,rootItemId:parent.rootItemId,sourceKey,sourceDigest:frozenSource.sourceDigest,
        inputText:frozenSource.inputText,inputSha256:continuationDigest(frozenSource.inputText),parentReportRevision:parent.reportRevision,
        parentOutcomeRevision:parent.outcomeRevision,planJson,planDigest:continuationDigest(planJson),createdAt:item.createdAt})
    }})
  }
  private replySource(id:string,sourceDigest:string):Readonly<WorkItemReplySource> {
    if(!this.config.ownerReplyContinuation) continuationFail('report reply continuation disabled')
    const delivery=this.context.get('assistantDelivery' as never) as PeerDeliveryService|undefined
    if(delivery?.workItemReplyProtocolVersion?.()!==1 || !delivery.readWorkItemReply) continuationFail('reply source peer unavailable')
    const source=delivery.readWorkItemReply({id,expectedSourceDigest:sourceDigest}),owner=this.owner(),scope=this.config.scope!
    immutableReply(source)
    if(source.id!==id || source.sourceDigest!==sourceDigest || source.state==='cancelled'
      || source.scope.workspace!==scope.workspace || source.scope.preset!==scope.preset || source.principalId!==scope.principalId
      || source.owner.principalRecordId!==owner.principalRecordId || source.owner.principalVersion!==owner.principalVersion
      || source.binding.generation!==owner.generation || source.binding.version!==owner.bindingVersion) continuationFail('reply source authority changed')
    return source
  }
  private parentSupplier(parent:ContinuationParent):Readonly<{modelSelection:ContinuationSource['modelSelection'];evidence:ReplySupplierEvidence}> {
    const item=this.store.findItemById(parent.itemId)
    if(!item) continuationFail('supplier parent missing')
    const continuation=this.store.getContinuation(item.id)
    let model:ContinuationSource['modelSelection'],kind:ReplySupplierEvidence['kind'],planDigest:string
    if(continuation) {
      const plan=parseStoredContinuationPlan(continuation.planJson)
      // proof() binds this exact immutable production to the sealed plan.
      const production=this.proof(item,parent.production.occurrenceId)
      if(acceptanceCanonicalJson(production)!==acceptanceCanonicalJson(parent.production)) continuationFail('supplier production changed')
      model={provider:plan.contract.provider,model:plan.contract.model,
        ...(Object.hasOwn(plan.contract,'reasoningEffort')?{reasoningEffort:plan.contract.reasoningEffort!}:{})}
      if(acceptanceCanonicalJson(model)!==acceptanceCanonicalJson(plan.source.modelSelection)) continuationFail('supplier contract differs from source')
      kind='continuation-plan';planDigest=continuation.planDigest
    } else {
      const plan=this.store.readDiagnosisPlan(item.id)
      if(!plan || plan.worker.owner!==DIAGNOSIS_OWNER || plan.worker.automationId!==item.workerAutomationId
        || parent.production.budgetSettlementState!=='finalized'
        || parent.production.immutableContext.owner!==DIAGNOSIS_OWNER
        || parent.production.immutableContext.definitionHash!==plan.worker.definitionHash
        || parent.production.immutableContext.definitionVersion!==plan.worker.definitionVersion) continuationFail('parent has no proven frozen diagnosis supplier')
      model={provider:plan.contract.provider,model:plan.contract.model,
        ...(Object.hasOwn(plan.contract,'reasoningEffort')?{reasoningEffort:plan.contract.reasoningEffort!}:{})}
      kind='diagnosis-plan';planDigest=continuationDigest(acceptanceCanonicalJson(plan))
    }
    return Object.freeze({modelSelection:Object.freeze(model),evidence:Object.freeze({kind,itemId:item.id,planDigest,production:parent.production})})
  }
  /** Local-only producer inspection. Delivery calls this while checking a
   * sidecar, so it must never re-enter Delivery or depend on terminal proof. */
  inspectReportStream(item:WorkItemRecord):Readonly<{streamId:string;planDigest:string}>|undefined {
    if(!this.config.ownerReplyContinuation || this.#closed || this.store.closed || item.observed) return undefined
    const scope=this.config.scope
    if(!scope || item.scope.workspace!==scope.workspace || item.scope.preset!==scope.preset
      || item.scope.principalId!==scope.principalId || item.scope.ownerRouteId!==scope.ownerRouteId
      || ![this.config.workerAutomationId,this.config.ownerContinuation!.automationId].includes(item.workerAutomationId)) return undefined
    const continuation=this.store.getContinuation(item.id)
    if(continuation) {
      const plan=parseStoredContinuationPlan(continuation.planJson)
      if(acceptanceCanonicalJson(plan.item)!==acceptanceCanonicalJson(continuationItemBasis(item))) return undefined
      return Object.freeze({streamId:isReplyContinuationPlan(plan)?plan.source.origin.reply.target.streamId:item.id,planDigest:continuation.planDigest})
    }
    const plan=this.store.readDiagnosisPlan(item.id)
    if(!plan || plan.worker.owner!==DIAGNOSIS_OWNER || plan.worker.automationId!==item.workerAutomationId) return undefined
    return Object.freeze({streamId:item.id,planDigest:continuationDigest(acceptanceCanonicalJson(plan))})
  }
  /** Pure local continuation eligibility; feedback metadata must not extend
   * the original execution scope or its deadline. */
  canAcceptReportReply():boolean {
    const scope=this.config.scope,settings=this.config.ownerContinuation
    return!this.#closed&&!this.#controller.signal.aborted&&!this.store.closed&&this.#activation?.stage==='established'
      &&this.config.ownerReplyContinuation===true&&!!scope&&!!settings&&Date.now()<Math.min(scope.expiresAt,settings.expiresAt)
  }
  /** Admission only: the caller must durably ACK this child before any wake. */
  prepareReply(id:string,sourceDigest:string,assertCurrent:()=>void):WorkItemContinuationAdmission {
    assertCurrent()
    const activation=this.assertActivation(),source=this.replySource(id,sourceDigest)
    if(!source.executionParentItemId || source.state!=='pending') continuationFail('reply has no frozen parent selection')
    const parent=this.parent(source.executionParentItemId),supplier=this.parentSupplier(parent)
    const frozenSource=JSON.parse(acceptanceCanonicalJson(source)) as WorkItemReplySource
    const sourceKey=continuationSourceKey(parent.itemId,sourceDigest)
    assertCurrent()
    return Object.freeze({parentItemId:parent.itemId,sourceDigest,sourceKey,create:(item:WorkItemRecord)=>{
      assertCurrent()
      const current=this.replySource(id,sourceDigest),currentParent=this.parent(parent.itemId),currentSupplier=this.parentSupplier(currentParent)
      if(acceptanceCanonicalJson(immutableReply(current))!==acceptanceCanonicalJson(immutableReply(frozenSource))
        || current.executionParentItemId!==parent.itemId || current.state!=='pending'
        || acceptanceCanonicalJson(currentParent)!==acceptanceCanonicalJson(parent)
        || acceptanceCanonicalJson(currentSupplier)!==acceptanceCanonicalJson(supplier)) continuationFail('reply changed before admission')
      const plan=createReplyContinuationPlan(item,current,parent,supplier,this.config,this.assertActivation(activation),this.schemas())
      const planJson=continuationCanonical(plan)
      assertCurrent()
      return Object.freeze({itemId:item.id,parentItemId:parent.itemId,rootItemId:parent.rootItemId,sourceKey,sourceDigest,
        inputText:current.inputText,inputSha256:current.inputSha256,parentReportRevision:parent.reportRevision,
        parentOutcomeRevision:parent.outcomeRevision,planJson,planDigest:continuationDigest(planJson),createdAt:item.createdAt})
    }})
  }
  private currentPlan(item:WorkItemRecord):Readonly<StoredContinuationPlan> {
    const record=this.store.getContinuation(item.id)
    if(!record) continuationFail('frozen record unavailable')
    const plan=parseStoredContinuationPlan(record.planJson),activation=this.assertActivation()
    this.hooks.assertOwner(item);this.hooks.assertMandate(item)
    if(plan.parent.itemId!==record.parentItemId || plan.parent.rootItemId!==record.rootItemId
      || plan.parent.reportRevision!==record.parentReportRevision || plan.parent.outcomeRevision!==record.parentOutcomeRevision
      || plan.source.digest!==record.sourceDigest || plan.source.inputSha256!==record.inputSha256 || plan.source.inputBytes!==record.inputBytes
      || Date.now()>=plan.authorization.expiresAt) continuationFail('frozen record association changed')
    const parent=this.store.findItemById(record.parentItemId)
    if(!parent || acceptanceCanonicalJson(this.proof(parent,plan.parent.production.occurrenceId))!==acceptanceCanonicalJson(plan.parent.production)) continuationFail('parent proof changed')
    const requireAcceptance=plan.contract.acceptance!==undefined
    if(requireAcceptance && this.config.acceptanceHoldReport===undefined) continuationFail('required acceptance is disabled')
    const expected=isReplyContinuationPlan(plan)?(()=>{
      const source=this.replySource(plan.source.origin.reply.id,record.sourceDigest)
      if(source.state!=='routed' || source.child?.itemId!==item.id || source.child.planDigest!==record.planDigest
        || source.executionParentItemId!==record.parentItemId
        || acceptanceCanonicalJson(immutableReply(source))!==acceptanceCanonicalJson(plan.source.origin.reply)) continuationFail('reply child is not durably acknowledged')
      return createReplyContinuationPlan(item,source,plan.parent,this.parentSupplier(plan.parent),this.config,activation,this.schemas(),requireAcceptance)
    })():createContinuationPlan(item,{sourceDigest:record.sourceDigest,inputText:record.inputText,modelSelection:plan.source.modelSelection},plan.parent,this.config,activation,this.schemas(),requireAcceptance)
    if(record.planJson!==continuationCanonical(expected)) continuationFail('frozen execution contract changed')
    return plan
  }
  private slotAvailable():boolean {
    if(this.#runs.size>0) return false
    if(this.store.continuationDispatchUncertain(this.config.ownerContinuation!.automationId)) return false
    const last=this.store.latestContinuationDispatch(this.config.ownerContinuation!.automationId)
    if(!last) return true
    if(!last.dispatch.occurrenceId) return false
    try {
      const proof=this.proof(last.item,last.dispatch.occurrenceId),plan=parseStoredContinuationPlan(last.continuation.planJson)
      return proof.immutableContext.definitionHash===plan.activation.definitionHash
        && proof.immutableContext.definitionVersion===plan.activation.definitionVersion
        && proof.immutableContext.owner===CONTINUATION_OWNER
    } catch {return false}
  }
  validateWake(item:WorkItemRecord):boolean {
    try {
      if(!this.slotAvailable() || item.observed || item.state!=='queued' || item.attempt!==0 || item.maxAttempts!==1) return false
      const dispatch=this.store.getDispatch(item.id)
      if(!dispatch || dispatch.state!=='pending' || dispatch.generation!==0 || dispatch.automationId!==this.config.ownerContinuation!.automationId) return false
      this.currentPlan(item)
      return this.isWakeCurrent(item)
    } catch {return false}
  }
  /** No peer calls: closes disposal during the final foreign wake check. */
  isWakeCurrent(item:WorkItemRecord):boolean {
    const scope=this.config.scope,settings=this.config.ownerContinuation
    if(this.#closed || this.#controller.signal.aborted || this.store.closed || this.#activation?.stage!=='established'
      || this.#runs.size>0 || !scope || !settings || Date.now()>=Math.min(scope.expiresAt,settings.expiresAt)) return false
    const record=this.store.getContinuation(item.id)
    if(!record) return false
    const plan=parseStoredContinuationPlan(record.planJson)
    if(plan.contract.acceptance!==undefined && this.config.acceptanceHoldReport===undefined) return false
    if(isReplyContinuationPlan(plan) && this.hooks.isReplyConsumerCurrent?.()!==true) return false
    return !this.#closed && !this.#controller.signal.aborted && !this.store.closed
  }
  wakePending():void {
    if(this.#closed || this.#waking) return
    this.#waking=true
    try {
      const automationId=this.config.ownerContinuation!.automationId,stored=this.store.readCanonicalMeta(PENDING_CURSOR_KEY)
      let after:{createdAt:number;id:string}|undefined
      if(stored!==undefined) {
        if(!stored || typeof stored!=='object' || Array.isArray(stored)) continuationFail('pending cursor malformed')
        const cursor=stored as {automationId?:unknown;after?:unknown}
        if(Object.keys(cursor).sort().join()!=='after,automationId' || cursor.automationId!==automationId) continuationFail('pending cursor scope differs')
        if(cursor.after!==null) {
          if(!cursor.after || typeof cursor.after!=='object' || Array.isArray(cursor.after)) continuationFail('pending cursor malformed')
          const value=cursor.after as {createdAt?:unknown;id?:unknown}
          if(Object.keys(value).sort().join()!=='createdAt,id' || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt)<1
            || typeof value.id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.id)) continuationFail('pending cursor position invalid')
          after={createdAt:Number(value.createdAt),id:value.id}
        }
      }
      const page=this.store.listPendingContinuations(automationId,10,after)
      let sent=false
      for(const {item} of page) {
        after={createdAt:item.createdAt,id:item.id}
        this.retireCancelledReply(item)
        if(this.validateWake(item) && this.hooks.wake(item)) {sent=true;break}
      }
      // Each native wake examines at most ten rows. A durable keyset cursor
      // reaches live rows behind stale owner generations and survives restarts.
      this.store.setMeta(PENDING_CURSOR_KEY,continuationCanonical({automationId,after:sent||page.length===10?after!:null}))
    } catch {this.#lastError='continuation-wake-unavailable'} finally {this.#waking=false}
  }
  private retireCancelledReply(item:WorkItemRecord):void {
    const record=this.store.getContinuation(item.id)
    if(!record) return
    const plan=parseStoredContinuationPlan(record.planJson)
    if(!isReplyContinuationPlan(plan)) return
    try {this.replySource(plan.source.origin.reply.id,record.sourceDigest)} catch(error) {
      if(!(error && typeof error==='object' && 'code' in error && error.code==='work-item-reply-cancelled')) return
      // A durable source cancellation only reduces local authority. It is not
      // proof that any already-dispatched occurrence or effect has stopped.
      const retired=this.store.withdrawByDedupKey(item.dedupKey,{sourceId:'owner-report-reply',externalId:item.externalId,observedAt:Date.now()})
      this.retire(retired.items.map(row=>row.id))
    }
  }
  private assertRun(run:Run):WorkItemRecord {
    if(this.#closed || this.#controller.signal.aborted || run.input.signal.aborted || run.controller.signal.aborted
      || this.#runs.get(run.input.occurrenceId)!==run) continuationFail('invocation revoked')
    const item=this.store.findItemById(run.itemId),dispatch=this.store.getDispatch(run.itemId)
    if(!item || item.observed || item.state==='dropped' || !dispatch || dispatch.state!=='dispatched'
      || dispatch.occurrenceId!==run.input.occurrenceId || this.currentPlan(item).digest!==run.plan.digest) continuationFail('item or occurrence changed')
    const claim=this.store.activeClaim(item.id),now=Date.now()
    if(run.phase==='before-claim') {
      if(claim?.runId===run.input.occurrenceId && claim.leasedUntil>now) run.phase='claimed'
      else if(item.state!=='queued' || item.attempt!==0 || claim) continuationFail('claim eligibility changed')
    }
    if(run.phase==='claimed' && (!claim || claim.runId!==run.input.occurrenceId || claim.leasedUntil<=now
      || item.leaseRunId!==run.input.occurrenceId || item.leaseUntil===null || item.leaseUntil<=now)) continuationFail('claim expired or changed')
    if(run.phase==='reported') {
      const report=this.store.lastReport(item.id)
      if(!report || report.revision!==run.reportRevision || report.status!==run.reportStatus || claim
        || item.lastReportStatus!==run.reportStatus || !['ready','blocked','failed'].includes(item.state)) continuationFail('report ownership changed')
    }
    return item
  }
  assertTool(occurrenceId:string,name:string):void {
    const run=this.#runs.get(occurrenceId)
    if(!run) continuationFail('tool requires live Host invocation')
    this.assertRun(run)
    if(!run.plan.contract.allowedTools.includes(name) || run.phase==='reported') continuationFail('tool outside current execution phase')
    if(name!=='work_item_claim' && run.phase!=='claimed') continuationFail('tool requires active claim')
  }
  reported(occurrenceId:string,status:WorkItemReportStatus,revision:number):void {
    const run=this.#runs.get(occurrenceId)
    if(!run || status==='progress') return
    if(!['ready','blocked','failed'].includes(status)) continuationFail('one-shot cannot wait or resume')
    run.phase='reported';run.reportStatus=status;run.reportRevision=revision
  }
  retire(itemIds:readonly string[]):void {
    for(const run of this.#runs.values()) if(itemIds.includes(run.itemId)) run.controller.abort('continuation-withdrawn')
  }
  readContext(occurrenceId:string,input:ContinuationContextInput) {
    this.assertTool(occurrenceId,'work_item_read_context')
    const run=this.#runs.get(occurrenceId)!,item=this.assertRun(run),record=this.store.getContinuation(item.id)!
    const kind=input.kind??'input',offset=input.offset??0,maxBytes=input.maxBytes??4096
    if(!['input','parent-brief','parent-report','parent-outcome'].includes(kind)
      || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(maxBytes) || maxBytes<4 || maxBytes>8192
      || input.revision!==undefined && (!Number.isSafeInteger(input.revision) || input.revision<1)
      || !['parent-report','parent-outcome'].includes(kind) && input.revision!==undefined) continuationFail('context selector invalid')
    let text:string,revision:number|undefined
    if(kind==='input') text=record.inputText
    else if(kind==='parent-brief') text=this.store.continuationParentBrief(item.id)
    else {
      const cutoff=kind==='parent-report'?record.parentReportRevision:record.parentOutcomeRevision
      revision=input.revision??cutoff??undefined
      if(revision===undefined || cutoff===null || revision>cutoff) continuationFail('context history unavailable')
      const row=kind==='parent-report'?this.store.continuationParentReports(item.id,revision-1,1)[0]:this.store.continuationParentOutcomes(item.id,revision-1,1)[0]
      if(!row || row.revision!==revision) continuationFail('context revision unavailable')
      // No idempotency keys, delivery bindings or hidden authority are exposed.
      text=kind==='parent-report'?('summary' in row?row.summary:continuationFail('report unavailable')):acceptanceCanonicalJson({revision:row.revision,...('settledBy' in row?{
        settledBy:row.settledBy,executionStatus:row.executionStatus,objectiveStatus:row.objectiveStatus,evidenceState:row.evidenceState,evidenceReason:row.evidenceReason,settledAt:row.settledAt}:{} )})
    }
    const bytes=Buffer.from(text,'utf8')
    if(offset>bytes.length || offset<bytes.length && (bytes[offset]!&0xc0)===0x80) continuationFail('context offset is not UTF-8 boundary')
    let end=Math.min(bytes.length,offset+maxBytes)
    while(end>offset && end<bytes.length && (bytes[end]!&0xc0)===0x80) end--
    this.assertRun(run)
    return Object.freeze({itemId:item.id,parentItemId:record.parentItemId,rootItemId:record.rootItemId,kind,
      ...(revision===undefined?{}:{revision}),parentReportRevision:record.parentReportRevision,parentOutcomeRevision:record.parentOutcomeRevision,
      text:bytes.subarray(offset,end).toString('utf8'),fullTextDigest:continuationDigest(text),fullBytes:bytes.length,returnedBytes:end-offset,offset,
      ...(end<bytes.length?{nextOffset:end}:{}),...(kind==='input'?{sourceDigest:record.sourceDigest}:{}),
      ...(revision!==undefined&&revision>1?{previousRevision:revision-1}:{}),
      ...(kind==='parent-report'&&revision!==undefined&&record.parentReportRevision!==null&&revision<record.parentReportRevision?{nextRevision:revision+1}:{}),
      ...(kind==='parent-outcome'&&revision!==undefined&&record.parentOutcomeRevision!==null&&revision<record.parentOutcomeRevision?{nextRevision:revision+1}:{})})
  }
  private async execute(input:HostAutomationExecutorInput):Promise<HostAutomationExecutorResult> {
    let started=false,run:Run|undefined,itemId:string|undefined
    try {
      const activation=this.assertActivation(),scope=this.config.scope!,settings=this.config.ownerContinuation!
      const item=this.store.findItemByOccurrence(input.occurrenceId),dispatch=item&&this.store.getDispatch(item.id)
      itemId=item?.id
      if(!item || !dispatch || item.state!=='queued' || item.attempt!==0 || item.observed || this.#runs.size>0
        || dispatch.state!=='dispatched' || dispatch.generation!==0 || input.executionMode!=='production' || input.automationId!==settings.automationId
        || input.definitionHash!==activation.definitionHash || input.activationNonce!==activation.activationNonce || input.catalogDigest!==activation.catalogDigest
        || input.ownerRouteId!==scope.ownerRouteId || input.principal!==scope.principalId
        || input.targetScope.workspace!==scope.workspace || input.targetScope.preset!==scope.preset) continuationFail('Host execution identity differs')
      const plan=this.currentPlan(item)
      run={input,itemId:item.id,plan,phase:'before-claim',controller:new AbortController()}
      this.#runs.set(input.occurrenceId,run);this.assertRun(run);started=true
      const result=await this.automations().runAgentForHostExecution!(input,plan.contract,
        {signal:AbortSignal.any([this.#controller.signal,run.controller.signal]),assertCurrent:()=>{this.assertRun(run!)}})
      this.assertRun(run)
      if(result.outcome==='succeeded' && result.quiescent===true && run.phase==='reported') return {
        outcome:'succeeded',failureClass:'none',failurePhase:'none',failureCode:'none',sideEffectState:'possible',retryability:'unsafe'}
      this.store.appendEvent(item.id,'continuation-unknown','continuation-runtime',{occurrenceId:input.occurrenceId,
        reason:result.quiescent!==true?'teardown-unconfirmed':run.phase!=='reported'?'report-missing':'agent-unsuccessful'})
      this.#lastError='continuation-awaits-intervention'
      return {outcome:result.quiescent===true&&result.outcome!=='unknown'?'failed':'unknown',failureClass:'execution',failurePhase:'host-execution',
        failureCode:'continuation-agent-incomplete',sideEffectState:'unknown',retryability:'unsafe'}
    } catch {
      this.#lastError=started?'continuation-awaits-intervention':'continuation-execution-refused'
      if(itemId && !this.store.closed) this.store.appendEvent(itemId,started?'continuation-unknown':'continuation-refused','continuation-runtime',{occurrenceId:input.occurrenceId})
      return started?{outcome:'unknown',failureClass:'unknown',failurePhase:'host-execution',failureCode:'continuation-execution-unknown',sideEffectState:'unknown',retryability:'unsafe'}
        :{outcome:'failed',failureClass:'policy',failurePhase:'preflight',failureCode:'continuation-execution-refused',sideEffectState:'none',retryability:'after-intervention'}
    } finally {if(run && this.#runs.get(input.occurrenceId)===run) this.#runs.delete(input.occurrenceId)}
  }
  health() {
    let ready=!this.#closed && this.#activation?.stage==='established'
    if(ready) {try {this.assertActivation()} catch {ready=false}}
    let interventionRequired=false
    if(this.#runs.size===0) {try {interventionRequired=!this.slotAvailable()} catch {interventionRequired=true}}
    return Object.freeze({enabled:true as const,ready:ready&&!interventionRequired,running:this.#runs.size,
      interventionRequired,lastError:interventionRequired?'continuation-awaits-intervention':!ready?'continuation-activation-unavailable':this.#lastError})
  }
  close():void {
    if(this.#closed) return
    this.#closed=true;this.#controller.abort('continuation-consumer-disposed');this.#remove?.();this.#remove=undefined
  }
}
