import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import type { OwnerForegroundTaskSourceScope } from './types.js'
import type { OwnerWorkItemLearningTask, OwnerWorkItemLearningTaskFenceInput } from './work-item-feedback.js'

export interface EngineeringReportRef {
  readonly itemId:string;readonly revision:number;readonly digest:string;readonly fullTextDigest:string;readonly fullBytes:number
  readonly status:'progress'|'waiting'|'ready'|'blocked'|'failed';readonly truncated:boolean
}
export type EngineeringRootInput=Readonly<{kind:'foreground';inboxId:string;sourceDigest:string;executionRef:string;completionSequence:number;binding:Readonly<{id:string;version:number;generation:number}>}>
export type EngineeringContinuationInput=Readonly<{kind:'continuation';sourceDigest:string;inputSha256:string;inputBytes:number;replyId?:string}>
export interface EngineeringNode {
  readonly itemId:string
  readonly planProtocol:'assistant-work-items/foreground-diagnosis-plan/v1'|'assistant-work-items/owner-continuation-plan/v1'|'assistant-work-items/owner-continuation-plan/v2'
  readonly planDigest:string
  readonly input:EngineeringRootInput|EngineeringContinuationInput
  readonly parent:Readonly<{itemId:string;rootItemId:string;report:EngineeringReportRef|null;outcomeRevision:number|null;productionDigest:string}>|null
}
export interface WorkItemEngineeringMaterial {
  readonly protocol:'assistant-work-items/engineering-material/v1';readonly itemId:string;readonly rootItemId:string;readonly feedbackProofDigest:string
  readonly nodes:readonly EngineeringNode[]
  readonly continuationInputs:readonly Readonly<{itemId:string;text:string;fullTextDigest:string;fullBytes:number}>[]
  readonly parentReports:readonly Readonly<{itemId:string;revision:number;text:string;fullTextDigest:string;fullBytes:number}>[]
  readonly materialDigest:string
}
export interface OwnerWorkItemEngineeringManifest {
  readonly protocol:'assistant-delivery/work-item-engineering-context/v1';readonly itemId:string;readonly rootItemId:string
  readonly feedbackProofDigest:string;readonly materialDigest:string;readonly nodes:readonly EngineeringNode[]
  readonly objective:Readonly<{protocol:'work-item-owner-objective/v1';fullTextDigest:string;fullBytes:number}>
  readonly reports:readonly EngineeringReportRef[];readonly manifestDigest:string
}
export type OwnerWorkItemEngineeringContextLocator=OwnerForegroundTaskSourceScope & Readonly<{itemId:string;outcomeId:string}>
export type OwnerWorkItemEngineeringContextExpectation=OwnerWorkItemLearningTaskFenceInput & Readonly<{expectedManifestDigest:string;expectedObjectiveDigest:string}>
export interface OwnerWorkItemEngineeringContext {readonly task:Readonly<OwnerWorkItemLearningTask>;readonly manifest:Readonly<OwnerWorkItemEngineeringManifest>}
export interface OwnerWorkItemEngineeringContextSource extends OwnerWorkItemEngineeringContext {readonly objective:string}
export type OwnerWorkItemEngineeringContextReadInput=OwnerWorkItemEngineeringContextExpectation & Readonly<{
  selector:Readonly<{kind:'objective'}>|Readonly<{kind:'parent-report';itemId:string;revision:number}>;offset?:number;maxBytes?:number
}>
export interface OwnerWorkItemEngineeringContextPage {readonly manifestDigest:string;readonly fullTextDigest:string;readonly fullBytes:number;readonly text:string;readonly offset:number;readonly returnedBytes:number;readonly nextOffset?:number}

const HEX=/^[a-f0-9]{64}$/u
function fail():never{throw new Error('invalid work item engineering context')}
const hash=(text:string):string=>createHash('sha256').update(text,'utf8').digest('hex')
const digest=(value:unknown):string=>hash(acceptanceCanonicalJson(value))
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const size=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=4096&&!/\p{Cc}/u.test(value)&&Buffer.from(value).toString('utf8')===value
const hex=(value:unknown):value is string=>typeof value==='string'&&HEX.test(value)
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail()
  const record=value as Record<string,unknown>,keys=Object.keys(record)
  if(required.some(key=>!Object.hasOwn(record,key))||keys.some(key=>!required.includes(key)&&!optional.includes(key)))return fail()
  return record
}
/** Snapshot plain inert data without invoking peer accessors or repairing original Unicode. */
export function engineeringContextData<T>(value:T):T{
  const ancestors=new Set<object>();let entries=0
  const visit=(part:unknown,depth:number):void=>{
    if(part===null||typeof part==='string'||typeof part==='boolean'||typeof part==='number'&&Number.isFinite(part))return
    if(!part||typeof part!=='object'||isProxy(part)||depth>20||ancestors.has(part)||++entries>20000)fail()
    const array=Array.isArray(part),prototype=Object.getPrototypeOf(part)
    if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)fail()
    ancestors.add(part)
    for(const key of Reflect.ownKeys(part)){
      if(array&&key==='length')continue
      const descriptor=Object.getOwnPropertyDescriptor(part,key)!
      if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail()
      visit(descriptor.value,depth+1)
    }
    ancestors.delete(part)
  }
  visit(value,0)
  const text=acceptanceCanonicalJson(value)
  if(Buffer.byteLength(text)>524288)fail()
  const result=JSON.parse(text) as T
  const freeze=(part:unknown):void=>{if(part&&typeof part==='object'){for(const child of Object.values(part))freeze(child);Object.freeze(part)}}
  freeze(result);return result
}
function textRecord(value:unknown,report:boolean):Record<string,unknown>{
  const record=exact(value,report?['itemId','revision','text','fullTextDigest','fullBytes']:['itemId','text','fullTextDigest','fullBytes'])
  if(!identifier(record.itemId)||report&&!positive(record.revision)||typeof record.text!=='string'||!size(record.fullBytes)||!hex(record.fullTextDigest)
    ||!report&&!record.text.trim()||Buffer.from(record.text).toString('utf8')!==record.text||Buffer.byteLength(record.text)!==record.fullBytes||hash(record.text)!==record.fullTextDigest)fail()
  return record
}
/** Defense in depth: source authority is still the producer-owned ephemeral capability. */
export function validateWorkItemEngineeringMaterial(value:unknown):Readonly<WorkItemEngineeringMaterial>{
  const data=engineeringContextData(value),material=exact(data,['protocol','itemId','rootItemId','feedbackProofDigest','nodes','continuationInputs','parentReports','materialDigest'])
  if(material.protocol!=='assistant-work-items/engineering-material/v1'||!identifier(material.itemId)||!identifier(material.rootItemId)||!hex(material.feedbackProofDigest)||!hex(material.materialDigest)
    ||!Array.isArray(material.nodes)||material.nodes.length<1||material.nodes.length>33||!Array.isArray(material.continuationInputs)||!Array.isArray(material.parentReports))fail()
  const nodes=material.nodes as unknown[],inputs=material.continuationInputs as unknown[],reports=material.parentReports as unknown[]
  const ids=new Set<string>(),selected:EngineeringReportRef[]=[]
  for(const [index,value] of nodes.entries()){
    const node=exact(value,['itemId','planProtocol','planDigest','input','parent'])
    if(!identifier(node.itemId)||ids.has(node.itemId)||!hex(node.planDigest))fail()
    ids.add(node.itemId as string)
    if(index===0){
      const input=exact(node.input,['kind','inboxId','sourceDigest','executionRef','completionSequence','binding']),binding=exact(input.binding,['id','version','generation'])
      if(node.itemId!==material.rootItemId||node.parent!==null||node.planProtocol!=='assistant-work-items/foreground-diagnosis-plan/v1'||input.kind!=='foreground'
        ||!identifier(input.inboxId)||input.executionRef!==input.inboxId||!hex(input.sourceDigest)||!positive(input.completionSequence)||!identifier(binding.id)||!positive(binding.version)||!positive(binding.generation))fail()
    }else{
      const input=exact(node.input,['kind','sourceDigest','inputSha256','inputBytes'],['replyId']),parent=exact(node.parent,['itemId','rootItemId','report','outcomeRevision','productionDigest'])
      if(node.planProtocol!=='assistant-work-items/owner-continuation-plan/v2'||input.kind!=='continuation'
        ||!hex(input.sourceDigest)||!hex(input.inputSha256)||!size(input.inputBytes)||input.inputBytes>16384||parent.itemId!==(nodes[index-1] as EngineeringNode).itemId
        ||parent.rootItemId!==material.rootItemId||!hex(parent.productionDigest)||parent.outcomeRevision!==null&&!positive(parent.outcomeRevision)
        ||(node.planProtocol==='assistant-work-items/owner-continuation-plan/v2'?!identifier(input.replyId):Object.hasOwn(input,'replyId')))fail()
      if(parent.report!==null){
        const report=exact(parent.report,['itemId','revision','digest','fullTextDigest','fullBytes','status','truncated'])
        if(report.itemId!==parent.itemId||!positive(report.revision)||!hex(report.digest)||!hex(report.fullTextDigest)||!size(report.fullBytes)||report.fullBytes>65536
          ||!['progress','waiting','ready','blocked','failed'].includes(String(report.status))||typeof report.truncated!=='boolean')fail()
        selected.push(report as unknown as EngineeringReportRef)
      }
    }
  }
  if((nodes.at(-1) as EngineeringNode).itemId!==material.itemId||inputs.length!==nodes.length-1||reports.length!==selected.length)fail()
  let inputBytes=0,reportBytes=0
  for(const [index,value] of inputs.entries()){
    const record=textRecord(value,false),node=nodes[index+1] as EngineeringNode,input=node.input as EngineeringContinuationInput
    if(record.itemId!==node.itemId||record.fullTextDigest!==input.inputSha256||record.fullBytes!==input.inputBytes)fail()
    inputBytes+=record.fullBytes as number
  }
  for(const [index,value] of reports.entries()){
    const record=textRecord(value,true),ref=selected[index]!
    if(record.itemId!==ref.itemId||record.revision!==ref.revision||record.fullTextDigest!==ref.fullTextDigest||record.fullBytes!==ref.fullBytes)fail()
    reportBytes+=record.fullBytes as number
  }
  if(inputBytes>16384||reportBytes>262144)fail()
  const {materialDigest,...unsigned}=material
  if(digest(unsigned)!==materialDigest)fail()
  return data as Readonly<WorkItemEngineeringMaterial>
}
export function frameWorkItemEngineeringContext(material:Readonly<WorkItemEngineeringMaterial>,rootText:string):Readonly<{manifest:OwnerWorkItemEngineeringManifest;objective:string}>{
  if(typeof rootText!=='string'||!rootText.trim()||Buffer.from(rootText).toString('utf8')!==rootText)fail()
  const objective=acceptanceCanonicalJson({protocol:'work-item-owner-objective/v1',inputs:material.nodes.map((node,index)=>({itemId:node.itemId,source:node.input,text:index===0?rootText:material.continuationInputs[index-1]!.text}))})
  if(Buffer.byteLength(objective)>16384)fail()
  const unsigned={protocol:'assistant-delivery/work-item-engineering-context/v1' as const,itemId:material.itemId,rootItemId:material.rootItemId,feedbackProofDigest:material.feedbackProofDigest,
    materialDigest:material.materialDigest,nodes:material.nodes,objective:{protocol:'work-item-owner-objective/v1' as const,fullTextDigest:hash(objective),fullBytes:Buffer.byteLength(objective)},reports:material.nodes.flatMap(node=>node.parent?.report?[node.parent.report]:[])}
  return Object.freeze({manifest:engineeringContextData({...unsigned,manifestDigest:digest(unsigned)}),objective})
}
export function pageWorkItemEngineeringContext(source:Readonly<{manifest:OwnerWorkItemEngineeringManifest;objective:string}>,material:Readonly<WorkItemEngineeringMaterial>,input:OwnerWorkItemEngineeringContextReadInput):Readonly<OwnerWorkItemEngineeringContextPage>{
  const selector=exact(input.selector,input.selector.kind==='objective'?['kind']:['kind','itemId','revision'])
  let text=source.objective
  if(selector.kind==='parent-report'){
    if(!identifier(selector.itemId)||!positive(selector.revision))fail()
    const report=material.parentReports.find(report=>report.itemId===selector.itemId&&report.revision===selector.revision)
    if(!report)fail();text=report.text
  }else if(selector.kind!=='objective')fail()
  const bytes=Buffer.from(text),offset=input.offset??0,limit=input.maxBytes??4096
  if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length||offset<bytes.length&&(bytes[offset]!&0xc0)===0x80||!Number.isSafeInteger(limit)||limit<4||limit>8192)fail()
  let end=Math.min(offset+limit,bytes.length)
  while(end>offset&&end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--
  return Object.freeze({manifestDigest:source.manifest.manifestDigest,fullTextDigest:hash(text),fullBytes:bytes.length,text:bytes.subarray(offset,end).toString('utf8'),offset,returnedBytes:end-offset,...(end<bytes.length?{nextOffset:end}:{})})
}
