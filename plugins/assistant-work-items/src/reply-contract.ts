import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NormalizedConfig } from './config.js'
import type { WorkItemReplySource } from './peers.js'
import type { WorkItemRecord } from './types.js'
import { MAX_CONTINUATION_INPUT_BYTES, MAX_CONTINUATION_PLAN_BYTES, continuationDigest } from './continuation-record.js'
import { continuationFail, createContinuationPlan, parseContinuationPlan,
  type ContinuationActivation, type ContinuationParent, type ContinuationProductionProof, type ContinuationSource, type WorkItemContinuationPlan } from './continuation-contract.js'

export interface ReplySupplierEvidence {
  readonly kind:'diagnosis-plan'|'continuation-plan'
  readonly itemId:string
  /** SHA-256 of the complete canonical parent plan, including its own digest. */
  readonly planDigest:string
  readonly production:ContinuationProductionProof
}
export function immutableReply(source:WorkItemReplySource) {
  if(source.protocol!=='assistant-delivery/work-item-reply/v1' || typeof source.id!=='string' || !source.id
    || !/^[a-f0-9]{64}$/u.test(source.sourceDigest) || source.inputSha256!==continuationDigest(source.inputText)
    || source.inputBytes!==Buffer.byteLength(source.inputText) || source.inputBytes<1 || source.inputBytes>MAX_CONTINUATION_INPUT_BYTES
    || Buffer.from(source.inputText,'utf8').toString('utf8')!==source.inputText) continuationFail('reply source bytes invalid')
  // ACK, delivery status and mutable stream head do not change source identity.
  return {protocol:source.protocol,id:source.id,sourceDigest:source.sourceDigest,admissionCursor:source.admissionCursor,
    inputSha256:source.inputSha256,inputBytes:source.inputBytes,scope:source.scope,principalId:source.principalId,
    owner:source.owner,binding:source.binding,target:source.target}
}
export interface WorkItemReplyContinuationPlan extends Omit<WorkItemContinuationPlan,'protocol'|'source'|'authorization'> {
  readonly protocol:'assistant-work-items/owner-continuation-plan/v2'
  readonly source:WorkItemContinuationPlan['source'] & Readonly<{
    origin:Readonly<{kind:'owner-report-reply';reply:ReturnType<typeof immutableReply>;supplier:ReplySupplierEvidence}>
  }>
  readonly authorization:Omit<WorkItemContinuationPlan['authorization'],'modelOrigin'> & Readonly<{modelOrigin:'inherited-parent-execution'}>
}
export type StoredContinuationPlan=WorkItemContinuationPlan|WorkItemReplyContinuationPlan
export const isReplyContinuationPlan=(plan:StoredContinuationPlan):plan is WorkItemReplyContinuationPlan=>plan.protocol==='assistant-work-items/owner-continuation-plan/v2'

export function createReplyContinuationPlan(item:WorkItemRecord,source:WorkItemReplySource,parent:ContinuationParent,
  supplier:Readonly<{modelSelection:ContinuationSource['modelSelection'];evidence:ReplySupplierEvidence}>,
  config:NormalizedConfig,activation:ContinuationActivation,schemas:readonly {name:string}[],requireAcceptance?:boolean):Readonly<WorkItemReplyContinuationPlan> {
  if(!config.ownerReplyContinuation || source.state==='cancelled' || source.executionParentItemId!==parent.itemId
    || source.scope.workspace!==item.scope.workspace || source.scope.preset!==item.scope.preset || source.principalId!==item.scope.principalId
    || source.owner.principalRecordId!==item.owner.principalRecordId || source.owner.principalVersion!==item.owner.principalVersion
    || source.binding.id!==item.originBindingId || source.binding.version!==item.owner.bindingVersion || source.binding.generation!==item.owner.generation
    || supplier.evidence.itemId!==parent.itemId || acceptanceCanonicalJson(supplier.evidence.production)!==acceptanceCanonicalJson(parent.production)) continuationFail('reply source admission association differs')
  const base=createContinuationPlan(item,{sourceDigest:source.sourceDigest,inputText:source.inputText,modelSelection:supplier.modelSelection},parent,config,activation,schemas,requireAcceptance)
  const {digest:_digest,...common}=base
  const unsigned={...common,protocol:'assistant-work-items/owner-continuation-plan/v2' as const,
    source:{...base.source,origin:{kind:'owner-report-reply' as const,reply:immutableReply(source),supplier:supplier.evidence}},
    authorization:{...base.authorization,modelOrigin:'inherited-parent-execution' as const}}
  const value={...unsigned,digest:acceptanceDigest(unsigned)},text=acceptanceCanonicalJson(value)
  if(Buffer.byteLength(text)>MAX_CONTINUATION_PLAN_BYTES) continuationFail('reply plan exceeds byte bound')
  return Object.freeze(JSON.parse(text) as WorkItemReplyContinuationPlan)
}
export function parseStoredContinuationPlan(text:string):Readonly<StoredContinuationPlan> {
  if(typeof text!=='string' || Buffer.byteLength(text)>MAX_CONTINUATION_PLAN_BYTES) continuationFail('stored plan exceeds bound')
  let value:unknown
  try {value=JSON.parse(text)} catch {continuationFail('stored plan is not JSON')}
  if(!value || typeof value!=='object' || Array.isArray(value)) continuationFail('stored plan malformed')
  if((value as {protocol?:unknown}).protocol!=='assistant-work-items/owner-continuation-plan/v2') return parseContinuationPlan(text)
  const plan=value as WorkItemReplyContinuationPlan
  if(acceptanceCanonicalJson(plan)!==text || Object.keys(plan).sort().join()!==['protocol','item','source','parent','authorization','activation','toolSchemas','contract','digest'].sort().join()
    || !plan.source || !plan.source.origin || plan.source.origin.kind!=='owner-report-reply' || !plan.source.origin.reply || !plan.source.origin.supplier
    || plan.source.origin.reply.protocol!=='assistant-delivery/work-item-reply/v1'
    || plan.authorization?.modelOrigin!=='inherited-parent-execution') continuationFail('stored reply plan malformed')
  const {digest,...unsigned}=plan
  if(typeof digest!=='string' || digest!==acceptanceDigest(unsigned)) continuationFail('stored reply plan digest differs')
  return Object.freeze(plan)
}
