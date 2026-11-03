import { symbols } from '@deepseek-ai/cordis'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedConfig } from './config.js'
import { truncateUtf8 } from './config.js'
import type { WorkItemContinuation } from './continuation.js'
import { continuationSourceKey, type WorkItemContinuationAdmission } from './continuation-record.js'
import { immutableReply, isReplyContinuationPlan, parseStoredContinuationPlan } from './reply-contract.js'
import type { PeerDeliveryService, WorkItemReplyConsumerRegistration, WorkItemReplySource, WorkItemReportTarget } from './peers.js'
import type { WorkItemStore } from './store.js'
import { WorkItemError, type WorkItemAdmitInput, type WorkItemAdmitResult, type WorkItemNotification, type WorkItemRecord, type WorkItemReportRecord } from './types.js'

const CURSOR_KEY='reply-continuation.scan/v1'
const identity=(peer:object):unknown=>(peer as Record<symbol,unknown>)[symbols.original]??peer
function fail(message:string):never {throw new WorkItemError('identity-mismatch',`owner report reply ${message}`)}
export interface WorkItemOwnerReplyDependencies {
  readonly config:NormalizedConfig
  readonly store:WorkItemStore
  readonly delivery:()=>PeerDeliveryService|undefined
  readonly runtime:()=>WorkItemContinuation|undefined
  readonly admit:(input:WorkItemAdmitInput,continuation:WorkItemContinuationAdmission)=>WorkItemAdmitResult
  readonly notification:(item:WorkItemRecord,report:WorkItemReportRecord)=>WorkItemNotification
  readonly retire:(items:readonly string[])=>void
}
/** The transport owns the queue and stream head; this adapter only drains it
 * into the existing admission/Host pipeline. No alternate session or timer. */
export class WorkItemOwnerReplies {
  readonly #registration:WorkItemReplyConsumerRegistration
  #active=false
  #closed=false
  #draining=false
  #peerIdentity:unknown
  #remove:(()=>void)|undefined
  #lastError:string|null=null
  constructor(private readonly dependencies:WorkItemOwnerReplyDependencies) {
    const config=dependencies.config
    const registration:WorkItemReplyConsumerRegistration={protocol:1,sourceId:config.intakeSourceId,continuationAutomationId:config.ownerContinuation?.automationId??'',
      inspectReport:input=>this.inspectReport(input),inspectChild:input=>this.inspectChild(input),
      onPending:()=>this.drain(),onCancelled:ids=>{if(this.#active && !this.#closed) this.dependencies.retire(ids)}}
    this.#registration=Object.freeze(registration)
  }
  owns(registration:unknown):boolean {return this.#active && !this.#closed && registration===this.#registration}
  isCurrent():boolean {return this.#active && !this.#closed}
  private peer():PeerDeliveryService {
    const peer=this.dependencies.delivery()
    if(!this.#active || this.#closed || !peer || identity(peer)!==this.#peerIdentity
      || peer.workItemReplyProtocolVersion?.()!==1 || !peer.registerWorkItemReplyConsumer || !peer.enqueueWorkItemReport
      || !peer.listPendingWorkItemReplies || !peer.readWorkItemReply || !peer.selectWorkItemReplyParent || !peer.acknowledgeWorkItemReply) fail('producer peer unavailable')
    const current=this.dependencies.delivery()
    if(!this.#active || this.#closed || !current || identity(current)!==this.#peerIdentity) fail('producer changed during inspection')
    return peer
  }
  start():void {
    const {config}=this.dependencies,peer=this.dependencies.delivery()
    if(this.#closed || this.#active || !config.ownerReplyContinuation || !config.ownerContinuation || !peer
      || peer.workItemReplyProtocolVersion?.()!==1 || !peer.registerWorkItemReplyConsumer) fail('explicit reply capability unavailable')
    this.#peerIdentity=identity(peer);this.#active=true
    try {
      const remove=this.peer().registerWorkItemReplyConsumer!(this.#registration)
      // A peer callback may synchronously dispose the consumer. Never retain
      // a registration acquired after that disposal crossed the call boundary.
      if(this.#closed || !this.#active) {remove();return}
      this.#remove=remove
    } catch(error) {this.#active=false;throw error}
    this.drain()
  }
  /** Local-only callbacks: Delivery invokes them inside its own validation
   * transaction; neither callback may re-enter Delivery. */
  private inspectReport(input:Parameters<WorkItemReplyConsumerRegistration['inspectReport']>[0]):WorkItemReportTarget|undefined {
    try {
      const {config,store}=this.dependencies,runtime=this.dependencies.runtime()
      if(!this.owns(this.#registration) || store.closed || !runtime || !config.scope
        || Date.now()>=Math.min(config.scope.expiresAt,config.ownerContinuation!.expiresAt)) return undefined
      const item=store.findItemById(input.itemId),report=store.reportByRevision(input.itemId,input.reportRevision)?.report
      if(!item || !report || !['ready','blocked','failed'].includes(report.status) || item.originBindingId!==input.bindingId
        || report.deliveryKey!==input.idempotencyKey || input.format!=='markdown') return undefined
      const fullSummary=store.ownerRecallText(item.id,report.revision),completeReport={...report,summary:fullSummary}
      if(this.dependencies.notification(item,completeReport).text!==input.text) return undefined
      const stream=runtime.inspectReportStream(item)
      if(!stream) return undefined
      // Exclude mutable delivery bookkeeping from the report's stable identity.
      const reportDigest=acceptanceDigest({itemId:item.id,revision:report.revision,status:report.status,summary:fullSummary,
        truncated:report.truncated,artifactPaths:report.artifactPaths,deliveryKey:report.deliveryKey,recordedAt:report.recordedAt,planDigest:stream.planDigest})
      return Object.freeze({protocol:'assistant-delivery/work-item-report/v1',itemId:item.id,reportRevision:report.revision,
        streamId:stream.streamId,reportDigest,sourceId:config.intakeSourceId,scope:{workspace:item.scope.workspace,preset:item.scope.preset},
        owner:{principalRecordId:item.owner.principalRecordId,principalVersion:item.owner.principalVersion}})
    } catch {return undefined}
  }
  canEnqueue(item:WorkItemRecord,report:WorkItemReportRecord,notification:WorkItemNotification):boolean {
    try {
      this.peer()
      return this.inspectReport({itemId:item.id,reportRevision:report.revision,bindingId:item.originBindingId,
        idempotencyKey:notification.idempotencyKey,text:notification.text,format:notification.format})!==undefined
    } catch {return false}
  }
  private inspectChild(input:Parameters<WorkItemReplyConsumerRegistration['inspectChild']>[0]):boolean {
    try {
      const {config,store}=this.dependencies
      if(!this.owns(this.#registration) || store.closed) return false
      const record=store.getContinuation(input.childItemId),item=store.findItemById(input.childItemId)
      if(!record || !item || item.workerAutomationId!==config.ownerContinuation?.automationId
        || record.planDigest!==input.childPlanDigest || record.parentItemId!==input.parentItemId || record.sourceDigest!==input.sourceDigest) return false
      const plan=parseStoredContinuationPlan(record.planJson)
      return isReplyContinuationPlan(plan) && plan.source.origin.reply.id===input.replyId && plan.source.origin.reply.sourceDigest===input.sourceDigest
        && plan.source.digest===input.sourceDigest && plan.item.id===input.childItemId && plan.parent.itemId===input.parentItemId
        && plan.source.inputSha256===record.inputSha256 && plan.source.inputBytes===record.inputBytes
    } catch {return false}
  }
  drain():void {
    if(!this.#active || this.#closed || this.#draining) return
    this.#draining=true
    try {
      const {config,store}=this.dependencies,scope=config.scope,runtime=this.dependencies.runtime(),peer=this.peer()
      if(!scope || !runtime || Date.now()>=Math.min(scope.expiresAt,config.ownerContinuation!.expiresAt)) return
      const owner=peer.validateOwnerRoute({authorityId:scope.ownerRouteId,principalId:scope.principalId,workspace:scope.workspace,agentPreset:scope.preset})
      let afterSequence:number|undefined
      const raw=store.meta(CURSOR_KEY)
      if(raw) {
        const parsed=JSON.parse(raw) as {sequence?:unknown}
        if(!parsed || Object.keys(parsed).join()!=='sequence' || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence)<0) fail('scan cursor malformed')
        afterSequence=Number(parsed.sequence)
      }
      const request={scope:{workspace:scope.workspace,preset:scope.preset},owner:{principalRecordId:owner.principalRecordId,principalVersion:owner.principalVersion},limit:10}
      const page=peer.listPendingWorkItemReplies!({...request,...(afterSequence===undefined?{}:{afterSequence})})
      for(const candidate of page.items) {
        try {this.route(candidate,runtime)} catch(error) {
          this.#lastError=error instanceof WorkItemError?error.code:'reply-awaits-parent-or-authority'
        }
      }
      // A scan cursor is not acknowledgement. Every waiting stream is reached
      // again after wrap, while other streams can advance past a blocked head.
      if(page.nextAfterSequence!==null && (!Number.isSafeInteger(page.nextAfterSequence) || page.nextAfterSequence<1)) fail('peer scan cursor malformed')
      store.setMeta(CURSOR_KEY,acceptanceCanonicalJson({sequence:page.nextAfterSequence??0}))
      runtime.wakePending()
    } catch(error) {this.#lastError=error instanceof WorkItemError?error.code:'reply-peer-unavailable'} finally {this.#draining=false}
  }
  private route(candidate:WorkItemReplySource,runtime:WorkItemContinuation):void {
    const {config,store}=this.dependencies,peer=this.peer()
    const source=peer.selectWorkItemReplyParent!({id:candidate.id,expectedSourceDigest:candidate.sourceDigest})
    if(!source.executionParentItemId || source.state!=='pending') fail('source has no pending selection')
    const sourceKey=continuationSourceKey(source.executionParentItemId,source.sourceDigest)
    const assertCurrent=()=>{
      if(this.dependencies.runtime()!==runtime) fail('runtime changed')
      const current=this.peer().readWorkItemReply!({id:source.id,expectedSourceDigest:source.sourceDigest})
      if(current.state!=='pending' || current.executionParentItemId!==source.executionParentItemId
        || acceptanceCanonicalJson(immutableReply(current))!==acceptanceCanonicalJson(immutableReply(source))) fail('source changed before acknowledgement')
    }
    assertCurrent()
    // Crash recovery looks up the durable child before attempting to mint a
    // second plan or re-evaluate a parent whose history may have advanced.
    let record=store.findContinuationBySourceKey(sourceKey)
    if(record) {
      if(!this.inspectChild({replyId:source.id,sourceDigest:source.sourceDigest,parentItemId:source.executionParentItemId,
        childItemId:record.itemId,childPlanDigest:record.planDigest})) fail('prior child does not bind this source')
    } else {
      const mint=runtime.prepareReply(source.id,source.sourceDigest,assertCurrent)
      const parent=store.findItemById(source.executionParentItemId)
      if(!parent || mint.parentItemId!==source.executionParentItemId || mint.sourceKey!==sourceKey) fail('parent selection differs from mint')
      const result=this.dependencies.admit({kind:'owner-continuation',externalId:sourceKey,title:truncateUtf8(`Continue: ${parent.title}`,256).value,
        brief:'Continue the authenticated owner report reply. Call work_item_read_context for the new instruction and linked prior reports before acting.',
        originBindingId:source.binding.id,provenance:{source:'owner-report-reply',sourceVersion:'assistant-delivery/work-item-reply/v1',
          signalDigest:source.sourceDigest,observedAt:Date.now(),evidence:{replyId:source.id,parentItemId:parent.id,streamId:source.target.streamId}}},mint)
      record=store.getContinuation(result.item.id)
      if(!record || result.item.workerAutomationId!==config.ownerContinuation!.automationId) fail('admitted child missing')
    }
    assertCurrent()
    const acknowledged=peer.acknowledgeWorkItemReply!({id:source.id,expectedSourceDigest:source.sourceDigest,
      childItemId:record.itemId,childPlanDigest:record.planDigest})
    if(acknowledged.state!=='routed' || acknowledged.child?.itemId!==record.itemId || acknowledged.child.planDigest!==record.planDigest) fail('child acknowledgement incomplete')
    this.#lastError=null
    // No external occurrence may be created before this durable ACK exists.
    runtime.wakePending()
  }
  health() {return Object.freeze({enabled:true as const,registered:this.#active&&!this.#closed,draining:this.#draining,lastError:this.#lastError})}
  close():void {
    if(this.#closed) return
    this.#closed=true;this.#active=false;this.#remove?.();this.#remove=undefined
  }
}
