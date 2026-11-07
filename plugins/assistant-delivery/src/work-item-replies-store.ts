import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConversationBinding, DeliveryPrincipal, InboxRecord, OutboxRecord } from './types.js'
import { externalPrincipalId } from './canonical.js'
import { WorkItemReplyCancelledError, workItemReplyCanonical, workItemReplyDigest,
  type WorkItemReportTarget, type WorkItemReplySource, type WorkItemReplyReadInput } from './work-item-replies.js'

type ImmutableSource = Omit<WorkItemReplySource, 'sourceDigest' | 'state' | 'child' | 'executionParentItemId'>
interface ReplyRow { inbox_id: string; stream_key: string; admission_sequence: number; source_digest: string; source_json: string;
  execution_parent_item_id: string | null; child_item_id: string | null; child_plan_digest: string | null; state: WorkItemReplySource['state'] }
export interface StoredWorkItemReport { target: WorkItemReportTarget; binding: WorkItemReplySource['binding']; intentHash: string; outbox: OutboxRecord }
const same = (a: unknown, b: unknown) => workItemReplyCanonical(a) === workItemReplyCanonical(b)
function fail(): never { throw new Error('work item reply authority or sequence changed') }
export class WorkItemRepliesStore {
  constructor(private readonly database: DatabaseSync, private readonly transaction: <T>(fn: () => T) => T,
    private readonly getInbox: (id: string) => InboxRecord | undefined,
    private readonly getBinding: (id: string) => ConversationBinding | undefined,
    private readonly getOutbox: (id: string) => OutboxRecord | undefined,
    private readonly getOwner: (binding: ConversationBinding) => DeliveryPrincipal | undefined) {}

  enqueueReport(target: WorkItemReportTarget, binding: ConversationBinding, enqueue: () => OutboxRecord): OutboxRecord {
    return this.transaction(() => {
      const current = this.getBinding(binding.id), owner = current === undefined ? undefined : this.getOwner(current)
      if (!current || !same(current,binding) || current.status !== 'active' || owner?.status !== 'active' || owner.role !== 'owner'
        || owner.id !== target.owner.principalRecordId || owner.version !== target.owner.principalVersion) fail()
      const outbox = enqueue()
      const bindingSnapshot = { id: binding.id, version: binding.version, generation: binding.generation }
      const expected = { intent_hash: outbox.intentHash, target_json: workItemReplyCanonical(target), binding_json: workItemReplyCanonical(bindingSnapshot) }
      const old = this.database.prepare('SELECT intent_hash,target_json,binding_json FROM delivery_work_item_reports WHERE outbox_id=?').get(outbox.id)
      if (old && !same(old, expected)) fail()
      if (!old) this.database.prepare('INSERT INTO delivery_work_item_reports(outbox_id,intent_hash,target_json,binding_json) VALUES(?,?,?,?)')
        .run(outbox.id, expected.intent_hash, expected.target_json, expected.binding_json)
      return outbox
    })
  }
  report(outboxId: string): StoredWorkItemReport | undefined {
    const row = this.database.prepare('SELECT intent_hash,target_json,binding_json FROM delivery_work_item_reports WHERE outbox_id=?').get(outboxId) as
      { intent_hash: string; target_json: string; binding_json: string } | undefined
    if (!row) return undefined
    const outbox = this.getOutbox(outboxId)
    if (!outbox || outbox.intentHash !== row.intent_hash) fail()
    return { outbox, intentHash: row.intent_hash, target: JSON.parse(row.target_json) as WorkItemReportTarget,
      binding: JSON.parse(row.binding_json) as WorkItemReplySource['binding'] }
  }
  replyReport(channel: string, account: string, providerMessageId: string): StoredWorkItemReport | undefined {
    const rows = this.database.prepare('SELECT id FROM outbox_messages WHERE channel=? AND account=? AND provider_message_id=? LIMIT 2')
      .all(channel,account,providerMessageId) as { id: string }[]
    return rows.length === 1 ? this.report(rows[0]!.id) : undefined
  }
  admit(inboxId: string, binding: ConversationBinding, report: StoredWorkItemReport): WorkItemReplySource {
    return this.transaction(() => this.admitInTransaction(inboxId, binding, report))
  }
  /**
   * Insert the continuation source. By default this owns the Inbox handoff;
   * `handoff: false` reuses the processed Inbox of an already-admitted result
   * inside the same outer transaction (mixed result+continuation admission).
   */
  admitInTransaction(inboxId: string, binding: ConversationBinding, report: StoredWorkItemReport,
    options?: Readonly<{ handoff?: boolean }>): WorkItemReplySource {
    const handoff = options?.handoff !== false
    const inbox = this.getInbox(inboxId)
    const current = this.getBinding(binding.id)
    const observed = this.report(report.outbox.id)
    const owner = current === undefined ? undefined : this.getOwner(current)
    if (owner?.status !== 'active' || owner.role !== 'owner' || owner.id !== report.target.owner.principalRecordId || owner.version !== report.target.owner.principalVersion) fail()
    if (!inbox || !current || !same(current, binding) || !same(observed, report)
      || !(handoff ? ['received','authorized'] : ['processed']).includes(inbox.status) || current.status !== 'active'
      || (!handoff && inbox.bindingId !== binding.id)
      || !['accepted','delivered','read'].includes(report.outbox.status) || !report.outbox.providerMessageId
      || inbox.envelope.metadata?.replyToProviderMessageId !== report.outbox.providerMessageId
      || !same(report.outbox.intent.target.conversation,inbox.envelope.conversation)
      || !same(inbox.envelope.conversation, binding.conversation) || !same(inbox.envelope.principal, binding.principal)
      || report.target.scope.workspace !== binding.workspace || report.target.scope.preset !== binding.agentPreset) fail()
    const text = inbox.envelope.text
    if (inbox.envelope.kind !== 'text' || text.trim().startsWith('/') || (inbox.envelope.attachments?.length ?? 0) > 0
      || Buffer.from(text,'utf8').toString('utf8') !== text || Buffer.byteLength(text,'utf8') > 262144) fail()
    const source: ImmutableSource = { protocol: 'assistant-delivery/work-item-reply/v1', id: inbox.id,
      admissionCursor: inbox.admissionCursor, inputText: text, inputSha256: createHash('sha256').update(text).digest('hex'), inputBytes: Buffer.byteLength(text),
      scope: report.target.scope, principalId: externalPrincipalId(binding.principal), owner: report.target.owner,
      binding: { id: binding.id, version: binding.version, generation: binding.generation }, target: { outboxId: report.outbox.id, providerMessageId: report.outbox.providerMessageId,
        itemId: report.target.itemId, reportRevision: report.target.reportRevision, reportDigest: report.target.reportDigest, streamId: report.target.streamId } }
    const streamKey = workItemReplyDigest({ conversation: binding.conversation, owner: source.owner, scope: source.scope,
      streamId: source.target.streamId, producer: report.target.sourceId })
    const sourceDigest = workItemReplyDigest(source)
    this.database.prepare('INSERT INTO delivery_work_item_reply_streams(stream_key,head_item_id,revision) VALUES(?,?,0) ON CONFLICT DO NOTHING')
      .run(streamKey, source.target.streamId)
    this.database.prepare(`INSERT INTO delivery_work_item_replies(inbox_id,stream_key,admission_sequence,source_digest,source_json,state) VALUES(?,?,?,?,?,'pending')`)
      .run(inbox.id, streamKey, inbox.admissionCursor.sequence, sourceDigest, workItemReplyCanonical(source))
    if (handoff) {
      const result = this.database.prepare(`UPDATE inbox_messages SET status='processed',binding_id=?,failure_code=NULL,updated_at=? WHERE id=? AND status IN ('received','authorized')`)
        .run(binding.id, inbox.updatedAt, inbox.id)
      if (result.changes !== 1) fail()
    }
    return this.read({ id: inbox.id, expectedSourceDigest: sourceDigest })
  }
  private row(id: string): ReplyRow | undefined {
    return this.database.prepare('SELECT * FROM delivery_work_item_replies WHERE inbox_id=?').get(id) as unknown as ReplyRow | undefined
  }
  read(input: WorkItemReplyReadInput): WorkItemReplySource {
    const row = this.row(input.id)
    if (!row || row.source_digest !== input.expectedSourceDigest) fail()
    const source = JSON.parse(row.source_json) as ImmutableSource
    if (workItemReplyDigest(source) !== row.source_digest || source.id !== row.inbox_id || source.admissionCursor.sequence !== row.admission_sequence) fail()
    if (row.state === 'cancelled') throw new WorkItemReplyCancelledError()
    return Object.freeze({ ...source, sourceDigest: row.source_digest, state: row.state,
      ...(row.execution_parent_item_id === null ? {} : { executionParentItemId: row.execution_parent_item_id }),
      ...(row.child_item_id === null ? {} : { child: Object.freeze({ itemId: row.child_item_id, planDigest: row.child_plan_digest! }) }) })
  }
  /** Historical engineering evidence only; never restores a cancelled route or execution permission. */
  inspectHistoricalSource(input:WorkItemReplyReadInput):WorkItemReplySource|undefined {
    const row=this.row(input.id)
    if(!row || row.source_digest!==input.expectedSourceDigest || !row.execution_parent_item_id || !row.child_item_id || !row.child_plan_digest
      || !['routed','cancelled'].includes(row.state))return undefined
    const raw=this.database.prepare('SELECT CAST(source_json AS BLOB) AS bytes FROM delivery_work_item_replies WHERE inbox_id=?').get(input.id) as {bytes:Uint8Array}|undefined
    if(!raw || !(raw.bytes instanceof Uint8Array))fail()
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes)
    if(!Buffer.from(text).equals(raw.bytes))fail()
    const source=JSON.parse(text) as ImmutableSource
    const fields=['protocol','id','admissionCursor','inputText','inputSha256','inputBytes','scope','principalId','owner','binding','target']
    if(!source || Object.keys(source).sort().join()!==fields.sort().join() || source.protocol!=='assistant-delivery/work-item-reply/v1'
      || workItemReplyCanonical(source)!==text || workItemReplyDigest(source)!==row.source_digest || source.id!==row.inbox_id
      || source.admissionCursor?.sequence!==row.admission_sequence || typeof source.inputText!=='string'
      || Buffer.from(source.inputText).toString('utf8')!==source.inputText || Buffer.byteLength(source.inputText)!==source.inputBytes
      || createHash('sha256').update(source.inputText).digest('hex')!==source.inputSha256 || !/^[a-f0-9]{64}$/u.test(row.child_plan_digest))fail()
    const inbox=this.getInbox(source.id)
    const envelope=this.database.prepare('SELECT CAST(envelope_json AS BLOB) AS bytes FROM inbox_messages WHERE id=?').get(source.id) as {bytes:Uint8Array}|undefined
    if(!inbox || !envelope || !(envelope.bytes instanceof Uint8Array))fail()
    const envelopeText=new TextDecoder('utf-8',{fatal:true}).decode(envelope.bytes)
    if(!Buffer.from(envelopeText).equals(envelope.bytes) || JSON.stringify(inbox.envelope)!==envelopeText
      || createHash('sha256').update(envelopeText).digest('hex')!==inbox.envelopeHash || !same(inbox.admissionCursor,source.admissionCursor)
      || inbox.bindingId!==source.binding.id || inbox.envelope.text!==source.inputText)fail()
    return Object.freeze({...source,sourceDigest:row.source_digest,state:row.state,executionParentItemId:row.execution_parent_item_id,
      child:Object.freeze({itemId:row.child_item_id,planDigest:row.child_plan_digest})})
  }
  pending(input: import('./work-item-replies.js').WorkItemReplyListInput): WorkItemReplySource[] {
    return (this.database.prepare(`SELECT r.inbox_id,r.source_digest FROM delivery_work_item_replies r
      WHERE r.state='pending' AND r.admission_sequence>?
        AND json_extract(r.source_json,'$.scope.workspace')=? AND json_extract(r.source_json,'$.scope.preset')=?
        AND json_extract(r.source_json,'$.owner.principalRecordId')=? AND json_extract(r.source_json,'$.owner.principalVersion')=? AND NOT EXISTS (
        SELECT 1 FROM delivery_work_item_replies earlier WHERE earlier.stream_key=r.stream_key AND earlier.state='pending'
        AND earlier.admission_sequence<r.admission_sequence) ORDER BY r.admission_sequence LIMIT ?`).all(input.afterSequence ?? 0,input.scope.workspace,input.scope.preset,input.owner.principalRecordId,input.owner.principalVersion,input.limit + 1) as unknown as
        { inbox_id: string; source_digest: string }[]).map(row => this.read({ id: row.inbox_id, expectedSourceDigest: row.source_digest }))
  }
  select(input: WorkItemReplyReadInput, validate: (source: WorkItemReplySource) => void): WorkItemReplySource {
    return this.transaction(() => {
      const source = this.read(input); validate(source)
      const row = this.row(input.id)!
      if (source.executionParentItemId !== undefined) return source
      const older = this.database.prepare("SELECT 1 FROM delivery_work_item_replies WHERE stream_key=? AND state='pending' AND admission_sequence<?").get(row.stream_key,row.admission_sequence)
      if (source.state !== 'pending' || older) fail()
      const head = this.database.prepare('SELECT head_item_id FROM delivery_work_item_reply_streams WHERE stream_key=?').get(row.stream_key) as { head_item_id: string }
      this.database.prepare('UPDATE delivery_work_item_replies SET execution_parent_item_id=? WHERE inbox_id=? AND execution_parent_item_id IS NULL').run(head.head_item_id,input.id)
      return this.read(input)
    })
  }
  acknowledge(input: WorkItemReplyReadInput & { childItemId: string; childPlanDigest: string }, validate: (source: WorkItemReplySource) => void): WorkItemReplySource {
    return this.transaction(() => {
      const source = this.read(input); validate(source)
      if (!source.executionParentItemId || !input.childItemId || !/^[a-f0-9]{64}$/u.test(input.childPlanDigest)) fail()
      if (source.child) { if (source.child.itemId !== input.childItemId || source.child.planDigest !== input.childPlanDigest) fail(); return source }
      const row = this.row(input.id)!
      const advanced = this.database.prepare('UPDATE delivery_work_item_reply_streams SET head_item_id=?,revision=revision+1 WHERE stream_key=? AND head_item_id=?')
        .run(input.childItemId,row.stream_key,source.executionParentItemId)
      if (advanced.changes !== 1 || source.state !== 'pending') fail()
      this.database.prepare("UPDATE delivery_work_item_replies SET child_item_id=?,child_plan_digest=?,state='routed' WHERE inbox_id=? AND state='pending'")
        .run(input.childItemId,input.childPlanDigest,input.id)
      return this.read(input)
    })
  }
  /** Called inside the command's durable cancellation transaction. Notify peers only after commit. */
  cancelBefore(bindingId: string, sequence: number): string[] {
    const rows = this.database.prepare(`SELECT child_item_id FROM delivery_work_item_replies WHERE json_extract(source_json,'$.binding.id')=? AND admission_sequence<? AND state!='cancelled'`)
      .all(bindingId,sequence) as { child_item_id: string | null }[]
    this.database.prepare(`UPDATE delivery_work_item_replies SET state='cancelled' WHERE json_extract(source_json,'$.binding.id')=? AND admission_sequence<? AND state!='cancelled'`).run(bindingId,sequence)
    return rows.flatMap(row => row.child_item_id === null ? [] : [row.child_item_id])
  }
}
