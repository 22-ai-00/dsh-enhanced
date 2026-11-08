import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { growthObjectDigest as acceptanceDigest, validateWorkItemSourceGrowthRunBinding,
  validateWorkItemRevisionSourceGrowthRunBinding,
  type WorkItemSourceGrowthRunBinding, type WorkItemRevisionSourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import type { AssistantDeliveryService, OwnerWorkItemLearningTask, OwnerWorkItemEngineeringManifest } from '@dsh-enhanced/assistant-delivery'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { OwnerWorkItemFailureReference } from './owner-task-gap-types.js'

export const WORK_ITEM_ENGINEERING_PROTOCOL = 'assistant-delivery/work-item-engineering-context/v1' as const
export type WorkItemEngineeringManifest = OwnerWorkItemEngineeringManifest
export interface WorkItemEngineeringSource {
  protocol: typeof WORK_ITEM_ENGINEERING_PROTOCOL
  task: OwnerWorkItemLearningTask
  manifest: WorkItemEngineeringManifest
  objective: string
}
// Preserve Delivery's exact required owner scope instead of re-declaring a
// narrower structural signature that can silently omit authentication fields.
export type WorkItemEngineeringDelivery = Pick<AssistantDeliveryService,
  'inspectOwnerWorkItemEngineeringContext' | 'withOwnerWorkItemEngineeringContextFence'>
const HEX=/^[a-f0-9]{64}$/u
/** Caller material is an inert expectation. No getter is evaluated before the trusted peer reread. */
export function inertCreationData<T>(input:T):T {
  let count=0
  const visit=(value:unknown,depth:number):unknown=>{
    if(++count>50000||depth>64)throw new Error('work item creation expectation exceeds bound')
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value
    if(typeof value==='string'){if(Buffer.from(value,'utf8').toString('utf8')!==value)throw new Error('work item creation text is not UTF-8');return value}
    if(typeof value!=='object'||utilTypes.isProxy(value)||(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw new Error('work item creation expectation must be inert')
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value)
    if(keys.some(key=>typeof key!=='string'||key==='__proto__'||(!Array.isArray(value)||key!=='length')&&(!descriptors[key]?.enumerable||!('value'in descriptors[key]!))))throw new Error('work item creation expectation has accessors')
    if(Array.isArray(value)){if(keys.length!==value.length+1)throw new Error('work item creation array is sparse');return value.map(item=>visit(item,depth+1))}
    return Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,visit(descriptor.value,depth+1)]))
  }
  const result=visit(input,0)
  if(Buffer.byteLength(JSON.stringify(result))>1048576)throw new Error('work item creation expectation exceeds byte bound')
  return result as T
}
export function workItemFailureReference(source:Omit<WorkItemEngineeringSource,'protocol'>):OwnerWorkItemFailureReference {
  const {task,manifest,objective}=inertCreationData(source),projection=task.canonical.projection
  if(task.protocol!=='assistant-delivery/owner-work-item-learning/v1'||task.judgement!=='owner-feedback'||task.canonical.objective?.status!=='not-achieved'
    ||projection.subjectKind!=='work-item'||projection.disposition!=='upsert'||manifest.protocol!==WORK_ITEM_ENGINEERING_PROTOCOL
    ||manifest.itemId!==projection.subjectRef||task.proofIdentity.itemId!==manifest.itemId||manifest.feedbackProofDigest!==task.proofIdentity.proofDigest
    ||!HEX.test(task.sourceDigest)||!HEX.test(task.presentationDigest)||!HEX.test(manifest.manifestDigest)||!HEX.test(manifest.materialDigest)
    ||manifest.objective.protocol!=='work-item-owner-objective/v1'||typeof objective!=='string'||!objective.trim()
    ||Buffer.byteLength(objective)<1||Buffer.byteLength(objective)>16384||manifest.objective.fullBytes!==Buffer.byteLength(objective)
    ||manifest.objective.fullTextDigest!==createHash('sha256').update(objective).digest('hex'))throw new Error('work item creation requires exact current owner engineering context')
  const {manifestDigest,...unsigned}=manifest
  if(acceptanceDigest(unsigned)!==manifestDigest)throw new Error('work item creation manifest digest changed')
  return {schemaVersion:2,sourceProtocol:WORK_ITEM_ENGINEERING_PROTOCOL,owner:task.owner as SourceJobOwnerReceipt,outcomeId:task.canonical.triggerOutcomeId,
    projection:{...projection,subjectKind:'work-item',disposition:'upsert'},sourceDigest:task.sourceDigest,presentationDigest:task.presentationDigest,
    context:{manifestDigest,objectiveDigest:manifest.objective.fullTextDigest,objectiveBytes:manifest.objective.fullBytes}}
}
export function assertWorkItemRunReference(run:WorkItemSourceGrowthRunBinding, reference:OwnerWorkItemFailureReference):void {
  validateWorkItemSourceGrowthRunBinding(run)
  if(run.mode!=='create'||run.source.itemId!==reference.projection.subjectRef||run.source.outcomeId!==reference.outcomeId
    ||acceptanceDigest(run.source.projection)!==acceptanceDigest(reference.projection)||run.source.sourceDigest!==reference.sourceDigest
    ||run.source.presentationDigest!==reference.presentationDigest||run.source.context.manifestDigest!==reference.context.manifestDigest
    ||run.source.context.objectiveDigest!==reference.context.objectiveDigest||run.source.context.objectiveBytes!==reference.context.objectiveBytes)throw new Error('work item creation run reference changed')
}
/** Revision corridor carries the identical work-item source; only the mode differs. */
export function assertWorkItemRevisionRunReference(run:WorkItemRevisionSourceGrowthRunBinding, reference:OwnerWorkItemFailureReference):void {
  validateWorkItemRevisionSourceGrowthRunBinding(run)
  if(run.mode!=='revise-created'||run.source.itemId!==reference.projection.subjectRef||run.source.outcomeId!==reference.outcomeId
    ||acceptanceDigest(run.source.projection)!==acceptanceDigest(reference.projection)||run.source.sourceDigest!==reference.sourceDigest
    ||run.source.presentationDigest!==reference.presentationDigest||run.source.context.manifestDigest!==reference.context.manifestDigest
    ||run.source.context.objectiveDigest!==reference.context.objectiveDigest||run.source.context.objectiveBytes!==reference.context.objectiveBytes)throw new Error('work item revision run reference changed')
}
