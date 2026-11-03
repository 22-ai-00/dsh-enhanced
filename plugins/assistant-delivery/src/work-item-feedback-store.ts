import type { DatabaseSync } from 'node:sqlite'
import type { InboxRecord } from './types.js'
import type { ObjectiveCommand } from './feedback-command.js'
import type { WorkItemFeedbackIntent, WorkItemFeedbackSource } from './work-item-feedback.js'
import { workItemReplyCanonical, workItemReplyDigest } from './work-item-replies.js'
interface Row { inbox_id:string;operation_id:string;admission_sequence:number;item_id:string;source_digest:string;source_json:string;state:WorkItemFeedbackIntent['state'];command_json:string|null;proof_digest:string|null;canonical_json:string|null }
export class WorkItemFeedbackStore {
  constructor(private readonly database:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T,private readonly getInbox:(id:string)=>InboxRecord|undefined){}
  get(inboxId:string):WorkItemFeedbackIntent|undefined{
    const row=this.database.prepare('SELECT * FROM delivery_work_item_feedback WHERE inbox_id=?').get(inboxId) as unknown as Row|undefined
    if(!row)return undefined
    const source=JSON.parse(row.source_json) as WorkItemFeedbackSource
    if(workItemReplyDigest(source)!==row.source_digest || source.inboxId!==row.inbox_id || source.operationId!==row.operation_id
      || source.admissionCursor.sequence!==row.admission_sequence || source.target.itemId!==row.item_id)throw new Error('invalid work item feedback source')
    return {source,sourceDigest:row.source_digest,state:row.state,...(row.command_json===null?{}:{command:JSON.parse(row.command_json) as ObjectiveCommand}),
      ...(row.proof_digest===null?{}:{proofDigest:row.proof_digest}),...(row.canonical_json===null?{}:{canonical:JSON.parse(row.canonical_json) as NonNullable<WorkItemFeedbackIntent['canonical']>})}
  }
  admit(source:WorkItemFeedbackSource,fence:()=>void):WorkItemFeedbackIntent{
    return this.transaction(()=>{
      fence()
      const inbox=this.getInbox(source.inboxId)
      if(!inbox || !['received','authorized'].includes(inbox.status) || inbox.envelopeHash!==source.envelopeHash || inbox.envelope.text!==source.inputText)throw new Error('feedback Inbox changed')
      this.database.prepare(`INSERT INTO delivery_work_item_feedback(inbox_id,operation_id,admission_sequence,item_id,source_digest,source_json,state) VALUES(?,?,?,?,?,?,'pending')`)
        .run(source.inboxId,source.operationId,source.admissionCursor.sequence,source.target.itemId,workItemReplyDigest(source),workItemReplyCanonical(source))
      const handed=this.database.prepare("UPDATE inbox_messages SET status='processed',binding_id=?,failure_code=NULL WHERE id=? AND status IN ('received','authorized')").run(source.binding.id,source.inboxId)
      if(handed.changes!==1)throw new Error('feedback Inbox handoff lost')
      return this.get(source.inboxId)!
    })
  }
  pending(afterSequence:number,limit:number):readonly WorkItemFeedbackIntent[]{
    const rows=this.database.prepare(`SELECT inbox_id FROM delivery_work_item_feedback WHERE state IN ('pending','frozen') AND admission_sequence>? ORDER BY admission_sequence LIMIT ?`)
      .all(afterSequence,limit) as {inbox_id:string}[]
    return rows.map(row=>this.get(row.inbox_id)!)
  }
  freeze(inboxId:string,command:ObjectiveCommand,proofDigest:string,fence:()=>void):WorkItemFeedbackIntent{
    return this.transaction(()=>{
      fence();const current=this.get(inboxId)
      if(!current)throw new Error('feedback intent missing')
      if(current.state!=='pending')return current
      // Canonical work-item identity, not an individual report/outbox, orders votes.
      const earlier=this.database.prepare(`SELECT 1 FROM delivery_work_item_feedback WHERE item_id=? AND admission_sequence<? AND state IN ('pending','frozen')
        AND json_extract(source_json,'$.scope')=json_extract(?,'$.scope') AND json_extract(source_json,'$.owner')=json_extract(?,'$.owner') LIMIT 1`)
        .get(current.source.target.itemId,current.source.admissionCursor.sequence,workItemReplyCanonical(current.source),workItemReplyCanonical(current.source))
      if(earlier)return current
      this.database.prepare("UPDATE delivery_work_item_feedback SET command_json=?,proof_digest=?,state='frozen' WHERE inbox_id=? AND state='pending'")
        .run(workItemReplyCanonical(command),proofDigest,inboxId)
      return this.get(inboxId)!
    })
  }
  settle(inboxId:string,state:'recorded'|'conflict'|'cancelled',canonical:WorkItemFeedbackIntent['canonical']|undefined,fence:()=>void):void{
    this.transaction(()=>{
      fence();const current=this.get(inboxId)
      if(!current || !['pending','frozen'].includes(current.state))return
      this.database.prepare('UPDATE delivery_work_item_feedback SET state=?,canonical_json=? WHERE inbox_id=? AND state IN (\'pending\',\'frozen\')')
        .run(state,canonical===undefined?null:workItemReplyCanonical(canonical),inboxId)
    })
  }
  findOutcome(outcomeId:string,operationId:string):WorkItemFeedbackIntent|undefined{
    const row=this.database.prepare("SELECT inbox_id FROM delivery_work_item_feedback WHERE state='recorded' AND operation_id=? AND json_extract(canonical_json,'$.outcomeId')=?")
      .get(operationId,outcomeId) as {inbox_id:string}|undefined
    return row===undefined?undefined:this.get(row.inbox_id)
  }
  byOperation(operationId:string):WorkItemFeedbackIntent|undefined{
    const row=this.database.prepare('SELECT inbox_id FROM delivery_work_item_feedback WHERE operation_id=?').get(operationId) as {inbox_id:string}|undefined
    return row?this.get(row.inbox_id):undefined
  }
  /** Cross-service canonical append can commit before this SQLite ACK; its stable operation remains the recovery key. */
  withOwnerWriterFence<T>(operationId:string,callback:(intent:WorkItemFeedbackIntent)=>T,
    verify:(intent:WorkItemFeedbackIntent,result:T)=>NonNullable<WorkItemFeedbackIntent['canonical']>):T{
    return this.transaction(()=>{
      const intent=this.byOperation(operationId)
      if(!intent || intent.state!=='frozen')throw new Error('owner feedback writer requires exact frozen intent')
      const result=callback(intent)
      const canonical=verify(intent,result)
      const updated=this.database.prepare("UPDATE delivery_work_item_feedback SET state='recorded',canonical_json=? WHERE inbox_id=? AND state='frozen'")
        .run(workItemReplyCanonical(canonical),intent.source.inboxId)
      if(updated.changes!==1)throw new Error('owner feedback ACK lost its frozen source')
      return result
    })
  }
  pendingAcknowledgements(afterSequence:number,limit:number):readonly WorkItemFeedbackIntent[]{
    const rows=this.database.prepare(`SELECT inbox_id FROM delivery_work_item_feedback f WHERE state IN ('recorded','conflict') AND admission_sequence>?
      AND NOT EXISTS(SELECT 1 FROM outbox_messages o WHERE o.idempotency_key='feedback:'||f.inbox_id||':ack') ORDER BY admission_sequence LIMIT ?`)
      .all(afterSequence,limit) as {inbox_id:string}[]
    return rows.map(row=>this.get(row.inbox_id)!)
  }
  cancelBefore(bindingId:string,sequence:number):void{
    this.database.prepare("UPDATE delivery_work_item_feedback SET state='cancelled' WHERE state IN ('pending','frozen') AND admission_sequence<? AND json_extract(source_json,'$.binding.id')=?").run(sequence,bindingId)
  }
}
