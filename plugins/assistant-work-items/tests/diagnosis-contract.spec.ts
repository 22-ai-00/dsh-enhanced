import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { normalizeConfig } from '../src/config.ts'
import { assertDiagnosisSource, canonicalDiagnosis, createDiagnosisPlan, diagnosisConfigurationDigest, diagnosisDefinition,
  diagnosisDefinitionHash, diagnosisExternalId, diagnosisToolDigest, DIAGNOSIS_SOURCE, DIAGNOSIS_TOOLS, parseDiagnosisPlan,
  type DiagnosisActivation } from '../src/diagnosis-contract.ts'
import type { PeerOwnerForegroundTaskSource } from '../src/peers.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemDispatchRecord, WorkItemRecord } from '../src/types.ts'
import { admitted, harness, receipt } from './fixtures.ts'

// Contract/SQLite fixtures only: these do not prove authenticated owner intake or native execution.
async function fixture() {
  const f = await harness(), generic = await admitted(f)
  const config = normalizeConfig({ enabled: true, mode: 'active', databasePath: f.config.databasePath, workRoot: f.config.workRoot,
    intakeSourceId: f.config.intakeSourceId, workerAutomationId: f.config.workerAutomationId!, scope: f.config.scope!,
    admission: { allowedKinds: ['review'] }, sources: { foregroundFailures: { enabled: true, kind: 'review', includeTimedOut: true } },
    diagnosis: { enabled: true, budgetId: 'diagnosis-runs', budgetAmount: 1, maxModelCalls: 5, maxToolCalls: 4,
      maxOutputTokens: 256, timeoutMs: 15000, expiresAt: f.now() + 3600000 } }, f.now())
  const owner = receipt({ authorityId: config.scope!.ownerRouteId, principalId: config.scope!.principalId,
    workspace: config.scope!.workspace, agentPreset: config.scope!.preset })
  const source: PeerOwnerForegroundTaskSource = { protocol: 'assistant-delivery/owner-foreground-source/v1', inboxId: 'original-inbox',
    sourceDigest: 'a'.repeat(64), completionSequence: 3, authorityId: owner.authorityId, authorityHash: owner.authorityHash,
    principalId: owner.principalId, scope: { workspace: owner.workspace, preset: owner.agentPreset },
    binding: { id: 'original-binding', version: owner.bindingVersion, generation: owner.generation, sessionId: 'original-session' },
    owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
    execution: { dispatchedAt: f.now() - 10, completedAt: f.now() - 1, executionRef: 'original-inbox', status: 'unknown', quiescent: false,
      modelSelectionState: 'frozen', modelSelection: { provider: 'original-provider', model: 'original-model' } },
    termination: { protocol: 'assistant-delivery/foreground-termination/v1', producer: 'delivery-agent', kind: 'error', causeCode: 'turn-error', handleDisposed: true, effects: 'unknown', replay: 'forbidden' } }
  const schemas = DIAGNOSIS_TOOLS.map(name => ({ name, description: `Read-only ${name}`, parameters: { type: 'object', additionalProperties: false } }))
  const activation: DiagnosisActivation = { protocol: 'assistant-work-items/diagnosis-activation/v1', stage: 'established',
    configurationDigest: diagnosisConfigurationDigest(config, schemas), activationNonce: 'b'.repeat(64), reconciliationKey: 'fixture-activation',
    definitionHash: diagnosisDefinitionHash(diagnosisDefinition(config, 'b'.repeat(64), 'c'.repeat(64))), definitionVersion: 1,
    catalogDigest: 'c'.repeat(64), ownerReceipt: owner }
  const record: WorkItemRecord = { ...generic, id: 'planned-item', dedupKey: 'planned-key', sourceId: DIAGNOSIS_SOURCE,
    externalId: diagnosisExternalId(source), originBindingId: source.binding.id }
  const plan = createDiagnosisPlan(record, source, config, activation, schemas)
  const dispatch: WorkItemDispatchRecord = { itemId: record.id, automationId: record.workerAutomationId, eventId: 'planned-event',
    occurredAt: record.createdAt, generation: 1, wakeAttempts: 0, state: 'pending', occurrenceId: null, reason: null, createdAt: record.createdAt, updatedAt: record.createdAt }
  const detail = { kind: record.kind, dedupBucket: record.dedupBucket, provenance: null }
  const insert = () => f.store.admitItem(record, { kind: 'admitted', actor: 'admission', detail }, dispatch, [], plan)
  return { ...f, generic, config, owner, source, schemas, activation, record, plan, dispatch, detail, insert }
}
function sql(path: string, callback: (db: DatabaseSync) => unknown): void { const db = new DatabaseSync(path); try { callback(db) } finally { db.close() } }
function rawDetail(path: string, itemId: string): Buffer {
  let result!: Buffer
  sql(path, db => { result = Buffer.from((db.prepare('SELECT CAST(detail AS BLOB) AS bytes FROM work_item_event WHERE item_id=? AND sequence=1').get(itemId) as { bytes: Uint8Array }).bytes) })
  return result
}
function replaceDetail(f: Awaited<ReturnType<typeof fixture>>, bytes: Uint8Array): void {
  sql(f.config.databasePath, db => db.prepare('UPDATE work_item_event SET detail=CAST(? AS TEXT) WHERE item_id=? AND sequence=1').run(bytes, f.record.id))
}

test('tool catalog digest covers complete schemas, is order stable, and rejects duplicate/missing names', async () => {
  const f = await fixture(), before = diagnosisToolDigest(f.schemas)
  expect(diagnosisToolDigest([...f.schemas].reverse())).toBe(before)
  expect(diagnosisToolDigest(f.schemas.map((schema, index) => index === 0 ? { ...schema, description: 'changed' } : schema))).not.toBe(before)
  expect(diagnosisToolDigest(f.schemas.map((schema, index) => index === 0 ? { ...schema, parameters: { ...schema.parameters, additionalProperties: true } } : schema))).not.toBe(before)
  expect(() => diagnosisToolDigest(f.schemas.slice(1))).toThrow()
  expect(() => diagnosisToolDigest([...f.schemas.slice(1), f.schemas[1]!])).toThrow()
})

test('freezes observed supplier absence without synthesizing an effort and refuses missing supplier evidence', async () => {
  const f = await fixture()
  expect(f.plan.contract).toMatchObject({ provider: 'original-provider', model: 'original-model' })
  expect(f.plan.contract).not.toHaveProperty('reasoningEffort')
  const explicit = { ...f.source, execution: { ...f.source.execution, modelSelection: { ...f.source.execution.modelSelection!, reasoningEffort: 'high' } } }
  expect(createDiagnosisPlan(f.record, explicit, f.config, f.activation, f.schemas).contract.reasoningEffort).toBe('high')
  const { modelSelection: _selection, ...execution } = f.source.execution
  expect(() => createDiagnosisPlan(f.record, { ...f.source, execution }, f.config, f.activation, f.schemas)).toThrow()
  expect(() => assertDiagnosisSource({ ...f.source, execution: { ...f.source.execution, modelSelectionState: 'inconsistent' } }, f.config, f.owner)).toThrow()
})

test('persists the plan canonically only in the original admitted event and survives reopen', async () => {
  const f = await fixture(); f.insert()
  expect(rawDetail(f.config.databasePath, f.record.id).toString('utf8')).toBe(canonicalDiagnosis({ ...f.detail, diagnosisPlan: f.plan }))
  expect(f.store.readDiagnosisPlan(f.record.id)).toEqual(f.plan); expect(f.store.getDispatch(f.record.id)).toEqual(f.dispatch)
  f.store.close()
  const reopened = new WorkItemStore(f.config.databasePath, { now: f.now })
  try { expect(reopened.readDiagnosisPlan(f.record.id)).toEqual(f.plan) } finally { reopened.close() }
})

test('rolls back item and admitted event when the later dispatch insert fails, then accepts the same admission once', async () => {
  const f = await fixture()
  sql(f.config.databasePath, db => db.exec(`CREATE TRIGGER fail_planned_dispatch BEFORE INSERT ON work_item_dispatch WHEN NEW.item_id='planned-item' BEGIN
    SELECT CASE WHEN (SELECT COUNT(*) FROM work_item WHERE id='planned-item')=1 AND (SELECT COUNT(*) FROM work_item_event WHERE item_id='planned-item')=1
    THEN RAISE(ABORT,'post-event-fault') ELSE RAISE(ABORT,'pre-event-fault') END; END`))
  expect(f.insert).toThrow(/post-event-fault/u)
  expect(f.store.findItemById(f.record.id)).toBeUndefined(); expect(f.store.getDispatch(f.record.id)).toBeUndefined()
  sql(f.config.databasePath, db => { expect(db.prepare('SELECT COUNT(*) AS n FROM work_item_event WHERE item_id=?').get(f.record.id)).toMatchObject({ n: 0 }); db.exec('DROP TRIGGER fail_planned_dispatch') })
  f.insert(); expect(f.store.readDiagnosisPlan(f.record.id)).toEqual(f.plan)
})

test('retains generic event bytes and cannot upgrade a planless item with a later event', async () => {
  const f = await fixture(), before = rawDetail(f.config.databasePath, f.generic.id)
  const legacyDetail = JSON.parse(before.toString('utf8'))
  expect(before.toString('utf8')).toBe(JSON.stringify({ kind: f.generic.kind, dedupBucket: f.generic.dedupBucket, provenance: legacyDetail.provenance }))
  expect(before.toString('utf8')).not.toBe(acceptanceCanonicalJson(legacyDetail))
  expect(f.store.readDiagnosisPlan(f.generic.id)).toBeUndefined(); f.insert()
  expect(rawDetail(f.config.databasePath, f.generic.id)).toEqual(before)
  sql(f.config.databasePath, db => db.prepare('UPDATE work_item SET authority_basis=NULL WHERE id=?').run(f.generic.id))
  expect(f.store.readDiagnosisPlan(f.generic.id)).toBeUndefined()
  const legacy = { ...f.record, id: 'planless-item', dedupKey: 'planless-key' }
  const laterPlan = createDiagnosisPlan(legacy, f.source, f.config, f.activation, f.schemas)
  f.store.admitItem(legacy, { kind: 'admitted', actor: 'admission', detail: f.detail }, { ...f.dispatch, itemId: legacy.id, eventId: 'planless-event' })
  f.store.appendEvent(legacy.id, 'admitted', 'admission', { ...f.detail, diagnosisPlan: laterPlan })
  expect(f.store.readDiagnosisPlan(legacy.id)).toBeUndefined()
})

test('rejects corrupt original event full bytes: BOM, NUL suffix, invalid UTF-8 and noncanonical JSON', async () => {
  for (const corruption of ['bom','nul','utf8','noncanonical']) {
    const f = await fixture(); f.insert(); const before = rawDetail(f.config.databasePath, f.record.id)
    const bytes = corruption === 'bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), before]) : corruption === 'nul' ? Buffer.concat([before, Buffer.from('\0hidden')]) : corruption === 'noncanonical' ? Buffer.concat([Buffer.from(' '), before]) : Buffer.from(before)
    if (corruption === 'utf8') bytes[bytes.indexOf('original-provider')] = 255
    replaceDetail(f, bytes)
    expect(() => f.store.readDiagnosisPlan(f.record.id), corruption).toThrow()
  }
})

test('rejects an altered plan or digest even when the outer event remains canonical', async () => {
  for (const corruption of ['contract','digest']) {
    const f = await fixture(); f.insert(); const detail = JSON.parse(rawDetail(f.config.databasePath, f.record.id).toString('utf8'))
    if (corruption === 'digest') detail.diagnosisPlan.digest = 'f'.repeat(64)
    else detail.diagnosisPlan.contract.provider = 'replacement-provider'
    replaceDetail(f, Buffer.from(acceptanceCanonicalJson(detail)))
    expect(() => parseDiagnosisPlan(detail.diagnosisPlan)).toThrow()
    expect(() => f.store.readDiagnosisPlan(f.record.id)).toThrow()
  }
})

test('rejects second admissions, observed originals, wrong actor/position and observed items', async () => {
  for (const corruption of ['duplicate','kind','kind-nul','actor','actor-nul','time','position','observed']) {
    const f = await fixture(); f.insert()
    if (corruption === 'duplicate') f.store.appendEvent(f.record.id, 'admitted', 'admission', { ...f.detail, diagnosisPlan: f.plan })
    else sql(f.config.databasePath, db => {
      if (corruption === 'kind') db.prepare("UPDATE work_item_event SET kind='observed' WHERE item_id=?").run(f.record.id)
      if (corruption === 'kind-nul') db.prepare('UPDATE work_item_event SET kind=CAST(? AS TEXT) WHERE item_id=?').run(Buffer.from('admitted\0hidden'), f.record.id)
      if (corruption === 'actor-nul') db.prepare('UPDATE work_item_event SET actor=CAST(? AS TEXT) WHERE item_id=?').run(Buffer.from('admission\0hidden'), f.record.id)
      if (corruption === 'actor') db.prepare("UPDATE work_item_event SET actor='other' WHERE item_id=?").run(f.record.id)
      if (corruption === 'time') db.prepare('UPDATE work_item_event SET recorded_at=recorded_at+1 WHERE item_id=?').run(f.record.id)
      if (corruption === 'position') db.prepare('UPDATE work_item_event SET sequence=2 WHERE item_id=?').run(f.record.id)
      if (corruption === 'observed') db.prepare('UPDATE work_item SET observed=1 WHERE id=?').run(f.record.id)
    })
    expect(() => f.store.readDiagnosisPlan(f.record.id), corruption).toThrow()
  }
})

test('fences changes to item source, binding, scope and authority after the plan was sealed', async () => {
  for (const column of ['external_id','origin_binding_id','source_id','kind','worker_automation_id','workspace','agent_preset','principal_id','principal_record_id','owner_route_id','authority_basis']) {
    for (const corruption of ['changed','nul-suffix']) {
      const f = await fixture(); f.insert()
      sql(f.config.databasePath, db => {
        if (corruption === 'nul-suffix') {
          const original = (db.prepare(`SELECT CAST(${column} AS BLOB) AS bytes FROM work_item WHERE id=?`).get(f.record.id) as { bytes: Uint8Array }).bytes
          db.prepare(`UPDATE work_item SET ${column}=CAST(? AS TEXT) WHERE id=?`).run(Buffer.concat([original, Buffer.from('\0hidden')]), f.record.id)
        } else if (column === 'authority_basis') db.prepare('UPDATE work_item SET authority_basis=NULL WHERE id=?').run(f.record.id)
        else db.prepare(`UPDATE work_item SET ${column}=? WHERE id=?`).run('changed-binding', f.record.id)
      })
      expect(() => f.store.readDiagnosisPlan(f.record.id), `${column}/${corruption}`).toThrow()
    }
  }
})
