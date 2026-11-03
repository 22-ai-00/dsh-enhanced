import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import { normalizeConfig, type Config } from '../src/config.ts'
import { CONTINUATION_OWNER, CONTINUATION_PROMPT_VERSION, continuationCanonical, continuationConfigurationDigest,
  continuationDefinition, continuationDefinitionHash, continuationOwnerLineage, createContinuationPlan, type ContinuationProductionProof } from '../src/continuation-contract.ts'
import { continuationDigest, continuationSourceKey } from '../src/continuation-record.ts'
import { WorkItemOwnerFeedbackTargets, workItemReportDigest } from '../src/feedback-targets.ts'
import type { PeerAutomationsService, PeerDeliveryService } from '../src/peers.ts'
import type { WorkItemRecord } from '../src/types.ts'
import { harness, readyItem, receipt } from './fixtures.ts'

/** Real shared ledger and two sealed continuation reports. Peers only return
 * recorded owner/production facts; no model or paid operation is installed. */
export async function feedbackFenceFixture() {
  const base = await harness(), parent = await readyItem(base)
  vi.spyOn(Date, 'now').mockImplementation(base.now)
  const raw: Config = { enabled: true, mode: 'active', databasePath: base.config.databasePath, workRoot: base.config.workRoot,
    intakeSourceId: base.config.intakeSourceId, workerAutomationId: base.config.workerAutomationId!, scope: base.config.scope!,
    ownerRecall: { enabled: true }, ownerReportFeedback: true, admission: { ...base.config.admission, allowedKinds: [...base.config.admission.allowedKinds, 'owner-continuation'] },
    ownerContinuation: { enabled: true, automationId: 'batch-continuation-worker',
      allowedTools: ['work_item_claim', 'work_item_report', 'work_item_read_context'], budgetId: 'continuations', budgetAmount: 1,
      maxModelCalls: 4, maxToolCalls: 6, maxOutputTokens: 256, timeoutMs: 15000, expiresAt: base.now() + 3600000 } }
  const config = normalizeConfig(raw, base.now())
  const owner = receipt({ authorityId: config.scope!.ownerRouteId, principalId: config.scope!.principalId,
    workspace: config.scope!.workspace, agentPreset: config.scope!.preset })
  const schemas = config.ownerContinuation!.allowedTools.map(name => ({ name, description: name, parameters: { type: 'object', additionalProperties: false } }))
  const catalogDigest = acceptanceDigest({ protocol: CONTINUATION_PROMPT_VERSION, schemas }), nonce = 'c'.repeat(64)
  const activation = { protocol: 'assistant-work-items/continuation-activation/v1' as const, stage: 'established' as const,
    configurationDigest: continuationConfigurationDigest(config, schemas), activationNonce: nonce, reconciliationKey: 'batch-established',
    definitionHash: continuationDefinitionHash(continuationDefinition(config, nonce, catalogDigest)), definitionVersion: 1, catalogDigest,
    ownerLineage: continuationOwnerLineage(owner) }
  const productions = new Map<string, ContinuationProductionProof>()
  const add = (id: string) => {
    const item: WorkItemRecord = { ...base.store.findItemById(parent.id)!, id, dedupKey: id, externalId: `source-${id}`, title: `Task ${id}`,
      brief: `original task ${id}\0tail 😀`, workerAutomationId: 'batch-continuation-worker', scope: config.scope!, state: 'queued', stateReason: null,
      attempt: 0, maxAttempts: 1, lastReportStatus: null, leaseUntil: null, leaseRunId: null, occurrenceId: null,
      authority: { ...parent.authority!, automationId: 'batch-continuation-worker' }, workDir: base.ledger.workspace.directoryFor(id),
      createdAt: base.now(), updatedAt: base.now() }
    const original = `authenticated request ${id}`, sourceDigest = continuationDigest(original)
    const parentProduction: ContinuationProductionProof = { protocol: 'assistant-automations/production-occurrence/v1', automationId: parent.workerAutomationId,
      occurrenceId: `occ-${parent.id}`, taskId: 'parent-task', attemptId: 'parent-attempt', runId: 'parent-run', executionMode: 'production', status: 'succeeded',
      completedAt: base.now(), quiescent: true, budgetSettlementState: 'not-required', immutableContext: { state: 'verified', definitionHash: 'e'.repeat(64),
        definitionVersion: 1, scope: { workspace: item.scope.workspace, agentPreset: item.scope.preset } } }
    const plan = createContinuationPlan(item, { sourceDigest, inputText: original, modelSelection: { provider: 'frozen-provider', model: 'frozen-model' } },
      { itemId: parent.id, rootItemId: parent.id, reportRevision: 1, outcomeRevision: 1, production: parentProduction }, config, activation, schemas)
    const planJson = continuationCanonical(plan), planDigest = continuationDigest(planJson), occurrenceId = `occurrence-${id}`
    base.store.admitItem(item, { kind: 'admitted', actor: 'admission' },
      { itemId: id, automationId: item.workerAutomationId, eventId: id, occurredAt: item.createdAt, generation: 0, wakeAttempts: 0,
        state: 'pending', occurrenceId: null, reason: null, createdAt: item.createdAt, updatedAt: item.createdAt }, [], undefined,
      { itemId: id, parentItemId: parent.id, rootItemId: parent.id, sourceKey: continuationSourceKey(parent.id, sourceDigest), sourceDigest,
        inputText: original, inputSha256: continuationDigest(original), parentReportRevision: 1, parentOutcomeRevision: 1, planJson, planDigest, createdAt: item.createdAt })
    base.store.markDispatchDispatched(id, occurrenceId)
    base.ledger.claim({ itemId: id, runId: occurrenceId, occurrenceId })
    const report = base.ledger.report({ itemId: id, runId: occurrenceId, status: 'ready', summary: `worker report ${id}\0tail 😀`, artifactPaths: [], idempotencyKey: `report-${id}` }).report
    productions.set(occurrenceId, { protocol: 'assistant-automations/production-occurrence/v1', automationId: item.workerAutomationId,
      occurrenceId, taskId: `native-task-${id}`, attemptId: `native-attempt-${id}`, runId: `native-run-${id}`, executionMode: 'production', status: 'succeeded',
      completedAt: base.now(), quiescent: true, budgetSettlementState: 'finalized', immutableContext: { state: 'verified', definitionHash: activation.definitionHash,
        definitionVersion: 1, scope: { workspace: item.scope.workspace, agentPreset: item.scope.preset }, owner: CONTINUATION_OWNER } })
    return { itemId: id, reportRevision: report.revision, reportDigest: workItemReportDigest(item, report, base.store.ownerRecallText(id, report.revision), planDigest) }
  }
  const a = add('batch-item-a'), b = add('batch-item-b')
  let active = true, onProduction: ((occurrenceId: string) => void) | undefined
  const calls: string[] = []
  const delivery: PeerDeliveryService = { validateOwnerRoute: () => ({ ...owner }), enqueueBackground: () => ({ id: 'unused' }) }
  const ingestExternal = vi.fn(() => { throw new Error('historical source fence must never ingest paid work') })
  const automations: PeerAutomationsService = { ingestExternal, inspectProductionOccurrence: input => {
    calls.push(input.occurrenceId); onProduction?.(input.occurrenceId)
    return productions.get(input.occurrenceId) as ReturnType<NonNullable<PeerAutomationsService['inspectProductionOccurrence']>>
  } }
  let currentDelivery = delivery, currentAutomations = automations
  const dependencies = { config, store: () => base.store, delivery: () => currentDelivery, automations: () => currentAutomations, current: () => active }
  const targets = new WorkItemOwnerFeedbackTargets(dependencies)
  const sql = (callback: (db: DatabaseSync) => void) => { const db = new DatabaseSync(config.databasePath); db.exec('PRAGMA busy_timeout=0'); try { callback(db) } finally { db.close() } }
  return { base, raw, config, dependencies, targets, a, b, calls, ingestExternal,
    hook: (callback: ((occurrenceId: string) => void) | undefined) => { onProduction = callback },
    deactivate: () => { active = false },
    replaceDelivery: () => { currentDelivery = { ...delivery } }, replaceAutomations: () => { currentAutomations = { ...automations } },
    sql, mutateReport: () => sql(db => db.prepare('UPDATE work_item_report SET summary=? WHERE item_id=? AND revision=1').run('changed A report\0hidden suffix', a.itemId)),
    mutatePlan: () => sql(db => db.prepare('UPDATE work_item_continuation SET plan_digest=? WHERE item_id=?').run('f'.repeat(64), a.itemId)),
  }
}
