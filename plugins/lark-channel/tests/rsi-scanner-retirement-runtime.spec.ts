import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, type Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { AssistantAutomationsService, inspectAutomationRetirementSnapshot, type AutomationRecord, type HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyScannerRetirementMaintenance, type ScannerRetirementOperation, type ScannerRetirementResult } from '../src/rsi-scanner-retirement-runtime.ts'

const require = createRequire(import.meta.url)
const roots: string[] = []
const owner = 'assistant-growth-usage'
const automationId = `usage-scan-${'a'.repeat(64)}`
interface Writer {
  reconcileSystemOwned(input: Record<string, unknown>): AutomationRecord
  getDefinitionHash(id: string): string
  retireSystemOwned(input: ScannerRetirementOperation): ScannerRetirementResult
  close(): void
}
const { AutomationStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-automations/package.json')), 'lib/store.js')).href) as {
  AutomationStore: { new (options: { path: string }): Writer; prototype: Writer }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const definition: HostAutomationDefinition = {
  name: 'Stopped staged scanner', workspace: '/work/owner', agentPreset: 'owner', principal: 'owner:probe',
  schedule: { kind: 'every', anchorAt: '2026-01-01T00:00:00.000Z', intervalMs: 60000 },
  timeoutMs: 60000, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
  execution: { kind: 'host', executorId: 'assistant-growth-usage-v1', executorContractVersion: 1,
    catalogDigest: 'd'.repeat(64), runbookId: 'scan', runbookVersion: 1,
    targetScope: { workspace: '/work/owner', preset: 'owner' }, scopeDigest: 'f'.repeat(64),
    ownerRouteId: 'probe-owner', activationNonce: 'probe-activation' },
}
function database<T>(path: string, action: (database: DatabaseSync) => T, write = false): T {
  const db = new DatabaseSync(path, { readOnly: !write })
  try { return action(db) } finally { db.close() }
}
function policyState(path: string) {
  return database(path, db => ({
    reservations: db.prepare('SELECT * FROM budget_reservations ORDER BY id').all(),
    periods: db.prepare('SELECT * FROM budget_periods ORDER BY scope,metric,period_start,period_ms').all(),
    audit: db.prepare('SELECT count(*) AS count FROM audit_events').get(),
  }))
}

async function fixture(options: { budget?: boolean; deny?: boolean; emergency?: boolean; exhausted?: boolean; v15?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scanner-retirement-runtime-')); roots.push(root)
  const databasePath = join(root, 'automations.sqlite'), policyPath = join(root, 'policy.sqlite')
  const writer = new AutomationStore({ path: databasePath })
  let operation: ScannerRetirementOperation
  try {
    const record = writer.reconcileSystemOwned({ owner, automationId, idempotencyKey: 'seed', definition })
    writer.reconcileSystemOwned({ owner: 'ordinary', automationId: 'ordinary-task', idempotencyKey: 'ordinary', definition })
    const definitionHash = writer.getDefinitionHash(automationId), evidenceDigest = 'b'.repeat(64)
    const operationId = `owner-revoked:${createHash('sha256').update(JSON.stringify([owner, automationId, definitionHash, record.version, evidenceDigest])).digest('hex')}`
    operation = { owner, automationId, definitionHash, evidenceDigest, operationId, expectedVersion: record.version, reason: 'owner-revoked' }
  } finally { writer.close() }
  database(databasePath, db => {
    const now = Date.now()
    db.prepare(`INSERT INTO automation_occurrences(id,automation_id,trigger_kind,trigger_key,scheduled_at,status,dry_run,created_at,updated_at)
      VALUES ('occurrence','ordinary-task','manual','manual',?,'unknown',0,?,?)`).run(now, now, now)
    db.prepare(`INSERT INTO automation_tasks(id,occurrence_id,automation_id,status,cancel_requested,attempt_count,created_at,updated_at)
      VALUES ('unknown-task','occurrence','ordinary-task','unknown',0,0,?,?)`).run(now, now)
    if (options.v15) db.exec(`DROP TRIGGER automation_retirements_no_update; DROP TRIGGER automation_retirements_no_delete;
      DROP TRIGGER automation_retired_no_activate_insert; DROP TRIGGER automation_retired_no_activate_update;
      DROP TABLE automation_system_retirements; PRAGMA user_version=15`)
  }, true)
  const policyConfig: PolicyConfig = {
    databasePath: policyPath, proposalMaintenanceIntervalMs: 1,
    budgets: options.budget ? [{ id: 'maintenance', metric: 'maintenance', limit: 1, periodMs: 86400000, scope: 'subject' }] : [],
    rules: [{ id: 'retire-only', effect: options.deny ? 'deny' : 'allow',
      subject: { kind: 'background', id: owner, workspace: definition.workspace, principal: definition.principal },
      actions: ['reconcile'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] },
      ...(options.budget ? { budget: { id: 'maintenance', amount: 1 } } : {}) }],
  }
  const ctx = new Context()
  const fiber = ctx.plugin(AssistantPolicyService, { ...policyConfig, proposalMaintenanceIntervalMs: 0 })
  try {
    await fiber.await()
    if (options.emergency) ctx.assistantPolicy.setEmergencyStop({ enabled: true, actor: 'owner', reason: 'incident' })
    if (options.exhausted) {
      const held = ctx.assistantPolicy.reserve({ budgetId: 'maintenance', amount: 1, idempotencyKey: 'old-spent-budget',
        subject: { kind: 'background', id: owner, workspace: definition.workspace, principal: definition.principal } })
      ctx.assistantPolicy.finalize(held.reservationId, 1)
    }
  } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  const input = { policyConfig, automationsConfig: { databasePath, runsPath: join(root, 'runs'),
    schedulerEnabled: true, reconcileIntervalMs: 1 }, operations: [operation!], signal: new AbortController().signal }
  return { input, databasePath, policyPath, before: inspectAutomationRetirementSnapshot(databasePath) }
}

describe('stopped-stage retirement through formal Cordis services', () => {
  test.each([false, true])('retains unknown tasks and history without enabling timers; v15=%s', async v15 => {
    const f = await fixture({ v15 })
    const original = structuredClone({ policy: f.input.policyConfig, automations: f.input.automationsConfig, operations: f.input.operations })
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const first = await applyScannerRetirementMaintenance(f.input)
    const second = await applyScannerRetirementMaintenance(f.input)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ replayed: false, definitionVersion: 2 })
    expect(second[0]).toEqual({ ...first[0], replayed: true })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(intervals).not.toHaveBeenCalled()
    const after = inspectAutomationRetirementSnapshot(f.databasePath)
    expect(after.historyTables).toEqual(f.before.historyTables)
    expect(after.records.find(row => row.id === 'ordinary-task')).toEqual(f.before.records.find(row => row.id === 'ordinary-task'))
    expect(after.records.find(row => row.id === automationId)).toMatchObject({ status: 'paused', version: 2 })
    expect(after.retirements).toHaveLength(1)
    expect(policyState(f.policyPath).reservations).toEqual([])
    expect({ policy: f.input.policyConfig, automations: f.input.automationsConfig, operations: f.input.operations }).toEqual(original)
  })

  test.each([{ deny: true }, { emergency: true }, { budget: true, exhausted: true }])('honors existing Policy restrictions %j', async options => {
    const f = await fixture(options), prior = policyState(f.policyPath)
    await expect(applyScannerRetirementMaintenance(f.input)).rejects.toThrow()
    const after = inspectAutomationRetirementSnapshot(f.databasePath)
    expect(after.records).toEqual(f.before.records)
    expect(after.historyTables).toEqual(f.before.historyTables)
    expect(after.retirements).toEqual([])
    const policy = policyState(f.policyPath)
    expect(policy.reservations).toEqual(prior.reservations)
    expect(policy.periods).toEqual(prior.periods)
    expect(Number(policy.audit?.count)).toBe(Number(prior.audit?.count) + 1)
  })

  test('retains one original budget charge when CAS fails after authorize and the same operation is retried', async () => {
    const f = await fixture({ budget: true })
    const fault = new Error('injected CAS failure after real Policy authorize')
    vi.spyOn(AutomationStore.prototype, 'retireSystemOwned').mockImplementationOnce(() => { throw fault })
    await expect(applyScannerRetirementMaintenance(f.input)).rejects.toBe(fault)
    expect(inspectAutomationRetirementSnapshot(f.databasePath).retirements).toEqual([])
    const charged = policyState(f.policyPath)
    expect(charged.reservations).toHaveLength(1)
    expect(charged.reservations[0]).toMatchObject({ amount: 1, actual_amount: 1, status: 'finalized' })
    expect(charged.periods[0]).toMatchObject({ limit_amount: 1, reserved_amount: 0, spent_amount: 1 })
    await applyScannerRetirementMaintenance(f.input)
    await applyScannerRetirementMaintenance(f.input)
    const retried = policyState(f.policyPath)
    expect(retried.reservations).toEqual(charged.reservations)
    expect(retried.periods).toEqual(charged.periods)
    expect(Number(retried.audit?.count)).toBe(Number(charged.audit?.count) + 2)
    expect(inspectAutomationRetirementSnapshot(f.databasePath).historyTables).toEqual(f.before.historyTables)
  })

  test('reports disposer errors swallowed by Cordis and does not claim successful settlement', async () => {
    const f = await fixture()
    const original = AutomationStore.prototype.close
    vi.spyOn(AutomationStore.prototype, 'close').mockImplementationOnce(function (this: Writer) {
      original.call(this)
      throw new Error('injected close failure')
    })
    await expect(applyScannerRetirementMaintenance(f.input)).rejects.toThrow('lifecycle failed')
    // A close acknowledgement failure is not a reason to replay with a new key.
    expect(inspectAutomationRetirementSnapshot(f.databasePath).retirements).toHaveLength(1)
    expect((await applyScannerRetirementMaintenance(f.input))[0]?.replayed).toBe(true)
  })

  test('cancellation before entry opens no service and leaves original state intact', async () => {
    const f = await fixture(), controller = new AbortController()
    controller.abort(new Error('cancelled staged upgrade'))
    const prior = policyState(f.policyPath)
    await expect(applyScannerRetirementMaintenance({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled staged upgrade')
    expect(policyState(f.policyPath)).toEqual(prior)
    expect(inspectAutomationRetirementSnapshot(f.databasePath).storageDigest).toBe(f.before.storageDigest)
  })

  test('an abort between operations preserves the first receipt and never dispatches the next operation', async () => {
    const f = await fixture(), controller = new AbortController(), initial = f.input.operations[0]!
    const nextOwner = 'plugin-control-plane-task-observations', nextId = `task-observation-scan-${'c'.repeat(64)}`
    const writer = new AutomationStore({ path: f.databasePath })
    let next: ScannerRetirementOperation
    try {
      const record = writer.reconcileSystemOwned({ owner: nextOwner, automationId: nextId, idempotencyKey: 'second', definition })
      const definitionHash = writer.getDefinitionHash(nextId), evidenceDigest = 'e'.repeat(64)
      next = { owner: nextOwner, automationId: nextId, definitionHash, expectedVersion: record.version, evidenceDigest,
        reason: 'owner-revoked', operationId: `owner-revoked:${createHash('sha256').update(JSON.stringify([nextOwner, nextId, definitionHash, record.version, evidenceDigest])).digest('hex')}` }
    } finally { writer.close() }
    const before = inspectAutomationRetirementSnapshot(f.databasePath)
    const original = AssistantAutomationsService.prototype.retireSystemOwned
    const retirement = vi.spyOn(AssistantAutomationsService.prototype, 'retireSystemOwned').mockImplementationOnce(function (this: AssistantAutomationsService, operation) {
      const receipt = original.call(this, operation)
      controller.abort(new Error('stop after first acknowledged retirement'))
      return receipt
    })
    await expect(applyScannerRetirementMaintenance({ ...f.input, operations: [initial, next!], signal: controller.signal }))
      .rejects.toThrow('stop after first acknowledged retirement')
    expect(retirement).toHaveBeenCalledOnce()
    const after = inspectAutomationRetirementSnapshot(f.databasePath)
    expect(after.retirements).toHaveLength(1)
    expect(after.records.find(row => row.id === nextId)).toEqual(before.records.find(row => row.id === nextId))
    expect(after.historyTables).toEqual(before.historyTables)
    expect((await applyScannerRetirementMaintenance(f.input))[0]?.replayed).toBe(true)
  })

  test('retains both the operation failure and a later disposer failure', async () => {
    const f = await fixture()
    const fault = new Error('primary retirement failure'), original = AutomationStore.prototype.close
    vi.spyOn(AutomationStore.prototype, 'retireSystemOwned').mockImplementationOnce(() => { throw fault })
    vi.spyOn(AutomationStore.prototype, 'close').mockImplementationOnce(function (this: Writer) {
      original.call(this); throw new Error('secondary close failure')
    })
    let error: unknown
    try { await applyScannerRetirementMaintenance(f.input) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toContain(fault)
    expect((error as AggregateError).errors.some(item => String(item).includes('lifecycle failed'))).toBe(true)
    expect(inspectAutomationRetirementSnapshot(f.databasePath).retirements).toEqual([])
  })

  test('rejects invalid or duplicate scanner operations before mounting writable services', async () => {
    const f = await fixture(), operation = f.input.operations[0]!
    const prior = policyState(f.policyPath)
    for (const operations of [[], [operation, operation], [{ ...operation, owner: 'ordinary' }], [{ ...operation, expectedVersion: 0 }]]) {
      await expect(applyScannerRetirementMaintenance({ ...f.input, operations })).rejects.toThrow()
    }
    expect(policyState(f.policyPath)).toEqual(prior)
    expect(inspectAutomationRetirementSnapshot(f.databasePath).storageDigest).toBe(f.before.storageDigest)
  })
})
