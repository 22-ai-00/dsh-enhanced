import { Context } from '@deepseek-ai/cordis'
import type { HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemAdmission } from '../src/admission.ts'
import { normalizeConfig } from '../src/config.ts'
import { WorkItemDiagnosis, persistedDiagnosisIntervention } from '../src/diagnosis.ts'
import { diagnosisDefinitionHash, DIAGNOSIS_OWNER, DIAGNOSIS_SOURCE, DIAGNOSIS_TOOLS, type WorkItemDiagnosisPlan } from '../src/diagnosis-contract.ts'
import { WorkItemDispatch } from '../src/dispatch.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import type { PeerAutomationsService, PeerOwnerForegroundTaskSource } from '../src/peers.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemAdmitInput, WorkItemRecord } from '../src/types.ts'
import { admitted, claim, harness, receipt, report } from './fixtures.ts'

// SQLite and intake component tests. Peer pages are recorded protocol fixtures;
// native Model/Delivery authorization and accounting are covered by integration.
async function component() {
  const f = await harness(), now = Date.now()
  const config = normalizeConfig({ enabled: true, mode: 'active', databasePath: f.config.databasePath, workRoot: f.config.workRoot,
    intakeSourceId: f.config.intakeSourceId, workerAutomationId: f.config.workerAutomationId!, admission: { ...f.config.admission, allowedKinds: [...f.config.admission.allowedKinds] }, scope: { ...f.config.scope!, expiresAt: now + 3600000 },
    sources: { foregroundFailures: { enabled: true, kind: 'review', maxCandidatesPerSweep: 10, maxAdmitsPerSweep: 2 } },
    diagnosis: { enabled: true, budgetId: 'diagnosis-budget', budgetAmount: 1, maxModelCalls: 5, maxToolCalls: 4,
      maxOutputTokens: 256, timeoutMs: 15000, expiresAt: now + 3600000 } }, now)
  const owner = receipt({ authorityId: config.scope!.ownerRouteId, principalId: config.scope!.principalId,
    workspace: config.scope!.workspace, agentPreset: config.scope!.preset })
  function source(sequence: number): PeerOwnerForegroundTaskSource {
    return { protocol: 'assistant-delivery/owner-foreground-source/v1', inboxId: `inbox-${sequence}`, sourceDigest: String(sequence).repeat(64),
      completionSequence: sequence, authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
      scope: { workspace: owner.workspace, preset: owner.agentPreset },
      binding: { id: `binding-${sequence}`, version: owner.bindingVersion, generation: owner.generation, sessionId: 'original-session' },
      owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      execution: { dispatchedAt: now - 10, completedAt: now - 1, executionRef: `inbox-${sequence}`, status: 'unknown', quiescent: false,
        modelSelectionState: 'frozen', modelSelection: { provider: 'original-provider', model: 'original-model' } },
      termination: { protocol: 'assistant-delivery/foreground-termination/v1', producer: 'delivery-agent', kind: 'error', causeCode: 'turn-error', handleDisposed: true, effects: 'unknown', replay: 'forbidden' } }
  }
  const sources = [source(2), source(4)]
  let page = { items: sources, nextCursor: { protocol: 'page/v1', epoch: 'epoch', scopeKey: 'scope', sequence: 5 }, watermark: 5, hasMore: false }
  const cursors: unknown[] = [], occurrences: string[] = []
  let definition!: HostAutomationDefinition
  let terminal: unknown
  const automations = { hostAgentAuthorizationVersion: () => 1 as const, registerHostExecutor: () => () => {},
    runAgentForHostExecution: async () => { throw new Error('not a native execution fixture') },
    reconcileSystem: (input: { definition: HostAutomationDefinition }) => { definition = input.definition },
    inspectSystemOwned: () => {
      if (!definition) throw Object.assign(new Error('not found'), { code: 'not-found' })
      return { owner: DIAGNOSIS_OWNER, automationId: config.workerAutomationId, automationStatus: 'active', definitionHash: diagnosisDefinitionHash(definition), definitionVersion: 1,
        latestTerminalRuns: { production: terminal } }
    },
    inspectSystemOwnedActivation: () => ({ definitionHash: diagnosisDefinitionHash(definition), activationNonce: definition.execution.activationNonce, ownerRouteId: config.scope!.ownerRouteId }),
    ingestExternal: () => { const id = `occurrence-${occurrences.length + 1}`; occurrences.push(id); return { id } },
  }
  const delivery = { validateOwnerRoute: () => owner, enqueueBackground: async () => ({ id: 'outbox' }),
    inspectOwnerForegroundTaskSource: ({ inboxId }: { inboxId: string }) => sources.find(item => item.inboxId === inboxId),
    readOwnerForegroundTaskInput: () => undefined,
    listOwnerForegroundTaskSources: ({ after }: { after?: unknown }) => { cursors.push(after); return page } }
  const schemas = DIAGNOSIS_TOOLS.map(name => ({ name, description: name, parameters: { type: 'object', additionalProperties: false } }))
  const context = { get: (name: string) => ({ assistantAutomations: automations, assistantDelivery: delivery, assistantPolicy: f.policy.service })[name as 'assistantAutomations'], tools: { schemas: () => schemas } } as unknown as Context
  const ledger = new WorkItemLedger({ store: f.store, workspace: f.ledger.workspace, limits: config.limits, diagnosis: true, now: f.now })
  let mint: ((item: WorkItemRecord) => Readonly<WorkItemDiagnosisPlan>) | undefined
  const admission = new WorkItemAdmission({ config, store: f.store, ledger, workspace: f.ledger.workspace, policy: f.policy.service, delivery, now: f.now,
    diagnosisPlanFor: () => mint })
  let runtime!: WorkItemDiagnosis
  const dispatch = new WorkItemDispatch({ config, store: f.store, ledger, automations: automations as unknown as PeerAutomationsService, delivery, now: f.now, validateWake: item => runtime.validateWake(item) })
  runtime = new WorkItemDiagnosis(context, config, f.store, admission, dispatch, { assertOwner: () => owner, assertMandate: () => {},
    admit: (input: WorkItemAdmitInput, builder) => { mint = builder; try { return admission.admit(input) } finally { mint = undefined } } })
  runtime.start()
  return { ...f, config, ledger, runtime, sources, occurrences, cursors,
    page: (value: typeof page) => { page = value },
    settled: (occurrenceId: string) => { const value = { occurrenceId, executionMode: 'production', status: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' },
      immutableContext: { state: 'verified', definitionHash: diagnosisDefinitionHash(definition), definitionVersion: 1,
        scope: { workspace: config.scope!.workspace, agentPreset: config.scope!.preset } } }; terminal = value; return value },
    terminal: (value: unknown) => { terminal = value } }
}

test('serial intake retains the second candidate cursor until the first report has exact outer success', async () => {
  const f = await component()
  try {
    expect(f.runtime.sweep(true).sources[0]?.admitted).toBe(1)
    expect(f.occurrences).toEqual(['occurrence-1'])
    expect(JSON.parse(f.store.meta(`signal.cursor:${DIAGNOSIS_SOURCE}`)!)).toMatchObject({ sequence: 2 })
    expect(f.runtime.sweep(true).sources[0]?.skipped).toBe('not-due')
    const item = f.store.listItems({ limit: 10 })[0]!
    f.ledger.claim({ itemId: item.id, runId: 'occurrence-1', occurrenceId: 'occurrence-1' })
    f.ledger.report({ itemId: item.id, runId: 'occurrence-1', status: 'ready', summary: 'diagnosis only', artifactPaths: [], idempotencyKey: 'ready' })
    expect(f.runtime.sweep(true).sources[0]?.skipped).toBe('not-due')
    f.settled('wrong-occurrence')
    expect(f.runtime.sweep(true).sources[0]?.skipped).toBe('not-due')
    const success = f.settled('occurrence-1')
    for (const invalid of [
      { ...success, status: 'unknown' }, { ...success, executionMode: 'preview' },
      { ...success, diagnostic: { budgetSettlementState: 'unknown' } },
      { ...success, immutableContext: { ...success.immutableContext, state: 'unverified' } },
      { ...success, immutableContext: { ...success.immutableContext, definitionHash: 'wrong' } },
      { ...success, immutableContext: { ...success.immutableContext, definitionVersion: 2 } },
      { ...success, immutableContext: { ...success.immutableContext, scope: { workspace: '/other', agentPreset: 'primary' } } },
    ]) {
      f.terminal(invalid)
      expect(f.runtime.sweep(true).sources[0]?.skipped).toBe('not-due')
      expect(f.occurrences).toHaveLength(1)
    }
    f.settled('occurrence-1')
    f.page({ items: [f.sources[1]!], nextCursor: { protocol: 'page/v1', epoch: 'epoch', scopeKey: 'scope', sequence: 5 }, watermark: 5, hasMore: false })
    expect(f.runtime.sweep(true).sources[0]?.admitted).toBe(1)
    expect(f.occurrences).toEqual(['occurrence-1', 'occurrence-2'])
    expect(f.store.listItems({ limit: 10 })).toHaveLength(2)
  } finally { f.runtime.close() }
})

test('intake follows empty filtered pages and nonempty filtered tails using the actual page cursor namespace', async () => {
  const f = await component()
  try {
    f.page({ items: [], nextCursor: { protocol: 'page/v1', epoch: 'epoch', scopeKey: 'scope', sequence: 1 }, watermark: 5, hasMore: true })
    expect(f.runtime.sweep(true).sources[0]?.scanned).toBe(0)
    expect(JSON.parse(f.store.meta(`signal.cursor:${DIAGNOSIS_SOURCE}`)!)).toMatchObject({ sequence: 1 })
    const ignored = { ...f.sources[0]!, execution: { ...f.sources[0]!.execution, modelSelectionState: 'missing' as const } }
    f.page({ items: [ignored], nextCursor: { protocol: 'page/v1', epoch: 'epoch', scopeKey: 'scope', sequence: 3 }, watermark: 5, hasMore: true })
    expect(f.runtime.sweep(true).sources[0]?.admitted).toBe(0)
    expect(f.cursors.at(-1)).toMatchObject({ sequence: 1 })
    expect(JSON.parse(f.store.meta(`signal.cursor:${DIAGNOSIS_SOURCE}`)!)).toMatchObject({ sequence: 3 })
    f.page({ items: [f.sources[1]!], nextCursor: { protocol: 'page/v1', epoch: 'epoch', scopeKey: 'scope', sequence: 5 }, watermark: 5, hasMore: false })
    expect(f.runtime.sweep(true).sources[0]?.admitted).toBe(1)
    expect(f.cursors.at(-1)).toMatchObject({ sequence: 3 })
  } finally { f.runtime.close() }
})

test('report occurrence proof uses the complete NUL key and exact released claim rather than latest run guesses', async () => {
  const f = await harness(), item = await admitted(f)
  claim(f, item.id, 'exact-occurrence'); report(f, item.id, 'waiting', 'exact-occurrence')
  expect(f.store.diagnosisReportOccurrence(item.id, 1)).toMatchObject({ occurrenceId: 'exact-occurrence', status: 'waiting' })
  const db = new DatabaseSync(f.config.databasePath)
  try {
    db.prepare("UPDATE work_item_claim SET occurrence_id='other-occurrence' WHERE item_id=?").run(item.id)
    expect(() => f.store.diagnosisReportOccurrence(item.id, 1)).toThrow(/completed claim/u)
    db.prepare("UPDATE work_item_claim SET occurrence_id=run_id,state='active' WHERE item_id=?").run(item.id)
    expect(() => f.store.diagnosisReportOccurrence(item.id, 1)).toThrow(/completed claim/u)
  } finally { db.close() }
})

test('expired diagnosis claims stay unknown without reclaim, new attempts or dispatch generations', async () => {
  const f = await harness(), item = await admitted(f)
  const ledger = new WorkItemLedger({ store: f.store, workspace: f.ledger.workspace, limits: f.config.limits, diagnosis: true, now: f.now })
  ledger.claim({ itemId: item.id, runId: 'unknown-run', occurrenceId: 'unknown-run' })
  const before = f.store.getDispatch(item.id), events = f.store.events(item.id).length
  f.advance(f.config.limits.leaseMs + 1)
  expect(ledger.recover()).toEqual({ requeued: [], blocked: [] })
  expect(() => ledger.claim({ itemId: item.id, runId: 'new-run', occurrenceId: 'new-run' })).toThrow()
  expect(() => ledger.claim({ itemId: item.id, runId: 'unknown-run', occurrenceId: 'unknown-run' })).toThrow()
  expect(f.store.findItemById(item.id)?.attempt).toBe(1)
  expect(f.store.getDispatch(item.id)).toEqual(before)
  expect(f.store.events(item.id)).toHaveLength(events)
})

test.each(['ready','waiting'] as const)('post-%s unknown survives reopen and only explicit reduction releases intervention', async status => {
  const f = await component()
  try {
    f.runtime.sweep(true); const item = f.store.listItems({ limit: 10 })[0]!
    f.ledger.claim({ itemId: item.id, runId: 'occurrence-1', occurrenceId: 'occurrence-1' })
    f.ledger.report({ itemId: item.id, runId: 'occurrence-1', status, summary: 'diagnosis', artifactPaths: [], idempotencyKey: status })
    // Crash before an unknown event is still unproven when no runtime can inspect the peer.
    expect(persistedDiagnosisIntervention(f.store, true)).toBe(true)
    f.store.appendEvent(item.id, 'diagnosis-unknown', 'diagnosis-runtime', { occurrenceId: 'occurrence-1' })
    f.settled('occurrence-1')
    expect(f.runtime.health()).toMatchObject({ interventionRequired: true, ready: false })
    expect(f.runtime.sweep(true).sources[0]?.skipped).toBe('not-due')
    const cold = new WorkItemStore(f.config.databasePath, { now: f.now })
    try {
      expect(persistedDiagnosisIntervention(cold, true)).toBe(true)
      expect(cold.diagnosisInterventionItems(1)[0]?.id).toBe(item.id)
      cold.clearDiagnosisIntervention(item.id)
      expect(cold.diagnosisInterventionItems(1)).toEqual([])
      expect(cold.findItemById(item.id)?.state).toBe(status)
      expect(cold.reports(item.id)).toHaveLength(1)
      expect(cold.getDispatch(item.id)?.generation).toBe(status === 'waiting' ? 1 : 0)
    } finally { cold.close() }
  } finally { f.runtime.close() }
})


test('existing diagnosis ledger cannot become active generic and observe never reclaims its old claim', async () => {
  const f = await component()
  f.runtime.sweep(true); const item = f.store.listItems({ limit: 10 })[0]!
  f.ledger.claim({ itemId: item.id, runId: 'occurrence-1', occurrenceId: 'occurrence-1' })
  f.store.appendEvent(item.id, 'diagnosis-unknown', 'diagnosis-runtime', { occurrenceId: 'occurrence-1' })
  f.runtime.close()
  const beforeDispatch = f.store.getDispatch(item.id), beforeItem = f.store.findItemById(item.id)
  const input = { enabled: true, mode: 'active' as const, databasePath: f.config.databasePath, workRoot: f.config.workRoot,
    workerAutomationId: f.config.workerAutomationId!, intakeSourceId: f.config.intakeSourceId, scope: f.config.scope!, admission: { allowedKinds: ['review'] } }
  const ctx = new Context(); ctx.provide('assistantPolicy', f.policy.service as never)
  try {
    await expect(Promise.resolve(ctx.plugin(AssistantWorkItemsService, input))).rejects.toThrow(/cannot be silently activated/u)
  } finally { await ctx.fiber.restart() }
  const observed = new Context(); observed.provide('assistantPolicy', f.policy.service as never)
  try {
    await observed.plugin(AssistantWorkItemsService, { ...input, mode: 'observe' })
    expect(observed.assistantWorkItems.health().diagnosis).toMatchObject({ ready: false, interventionRequired: true })
    expect(f.store.getDispatch(item.id)).toEqual(beforeDispatch)
    expect(f.store.findItemById(item.id)).toEqual(beforeItem)
  } finally { await observed.fiber.restart() }
})
