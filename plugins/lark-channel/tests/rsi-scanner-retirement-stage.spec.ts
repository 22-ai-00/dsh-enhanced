import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, type Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { AssistantAutomationsService, inspectAutomationRetirementSnapshot, type AutomationRecord, type HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { externalPrincipalId, ownerRouteAuthorityHash, type DeliveryPrincipal } from '@dsh-enhanced/assistant-delivery'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { stringify } from 'yaml'
import { createRsiMemoryLearningSetup } from '../src/rsi-memory-learning.ts'
import { applyScannerRetirementMaintenance } from '../src/rsi-scanner-retirement-runtime.ts'
import { deriveScannerRetirementConfiguration } from '../src/rsi-scanner-retirement-config.ts'
import { captureScannerRetirementPlan, applyScannerRetirementPlan, verifyScannerRetirementPersistence, type ScannerRetirementPlan } from '../src/rsi-scanner-retirement-stage.ts'

const require = createRequire(import.meta.url)
interface AutomationWriter {
  reconcileSystemOwned(input: Record<string, unknown>): AutomationRecord
  close(): void
}
interface DeliveryWriter {
  issuePairing(principal: Record<string, unknown>, options: Record<string, unknown>): { challenge: { id: string }; code: string }
  confirmPairing(input: Record<string, unknown>): DeliveryPrincipal
  createBinding(input: Record<string, unknown>): unknown
  revokePrincipal(id: string, version: number): DeliveryPrincipal
  close(): void
}
const { AutomationStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-automations/package.json')), 'lib/store.js')).href) as {
  AutomationStore: { new (options: { path: string }): AutomationWriter; prototype: AutomationWriter }
}
const { DeliveryStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-delivery/package.json')), 'lib/store.js')).href) as {
  DeliveryStore: { new (options: { path: string; codeGenerator?: () => string }): DeliveryWriter }
}
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function database<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return action(db) } finally { db.close() }
}
const triggers = ['automation_retirements_no_update', 'automation_retirements_no_delete', 'automation_retired_no_activate_insert', 'automation_retired_no_activate_update']
function downgrade(path: string) {
  database(path, db => { for (const name of triggers) db.exec(`DROP TRIGGER ${name}`); db.exec('DROP TABLE automation_system_retirements; PRAGMA user_version=15') })
}
function history(path: string, suffix = '') {
  database(path, db => {
    const now = Date.now()
    db.prepare(`INSERT INTO automation_occurrences(id,automation_id,trigger_kind,trigger_key,scheduled_at,status,dry_run,created_at,updated_at)
      VALUES (?, 'ordinary', 'manual', ?, ?, 'unknown', 0, ?, ?)`).run(`occurrence${suffix}`, `manual${suffix}`, now, now, now)
    db.prepare(`INSERT INTO automation_tasks(id,occurrence_id,automation_id,status,cancel_requested,attempt_count,created_at,updated_at)
      VALUES (?, ?, 'ordinary', 'unknown', 0, 0, ?, ?)`).run(`unknown${suffix}`, `occurrence${suffix}`, now, now)
  })
}
function policyState(path: string) {
  return database(path, db => ({ reservations: db.prepare('SELECT * FROM budget_reservations ORDER BY id').all(),
    periods: db.prepare('SELECT * FROM budget_periods ORDER BY scope,metric,period_start,period_ms').all() }))
}
async function fixture(options: { version?: 15 | 16; memoryOnly?: boolean; active?: boolean; missing?: boolean; deny?: boolean; minimumGeneration?: number } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'scanner-retirement-stage-'))); roots.push(home)
  const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
  const authority = { id: 'rsi-owner', conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm' as const, chat: 'oc_owner' },
    principal, workspace: join(home, 'workspace'), agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: options.minimumGeneration ?? 1 }
  const deliveryPath = join(home, 'delivery.sqlite'), automationsPath = join(home, 'automations.sqlite'), policyPath = join(home, 'policy.sqlite')
  const delivery = new DeliveryStore({ path: deliveryPath, codeGenerator: () => 'PAIR1234' })
  let paired: DeliveryPrincipal
  try {
    const issued = delivery.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 3 })
    paired = delivery.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
    delivery.createBinding({ conversation: authority.conversation, principal, workspace: authority.workspace, agentPreset: authority.agentPreset,
      sessionId: 'owner-session', policyRef: authority.policyRef })
    if (!options.active) delivery.revokePrincipal(paired.id, paired.version)
  } finally { delivery.close() }
  const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority), principalId: externalPrincipalId(principal),
    principalRecordId: paired!.id, principalVersion: paired!.version, workspace: authority.workspace, agentPreset: authority.agentPreset }
  const scope = { ownerRouteId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, preset: owner.agentPreset }
  const memory = createRsiMemoryLearningSetup({ installationId: 'stage', stateRoot: join(home, 'learning'), owner,
    now: Date.now(), expiresAt: Date.now() + 60_000 })
  const policy: PolicyConfig = { databasePath: policyPath, proposalMaintenanceIntervalMs: 1234,
    budgets: [{ id: 'old-retirement', metric: 'maintenance', limit: options.memoryOnly ? 1 : 4, periodMs: 86400000, scope: 'global' }],
    rules: [{ id: 'old-authorization', effect: options.deny ? 'deny' : 'allow',
      subject: { kind: 'background', id: '*', workspace: owner.workspace, principal: owner.principalId }, actions: ['reconcile'],
      resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'old-retirement', amount: 1 } }] }
  const automations = { databasePath: automationsPath, runsPath: join(home, 'runs'), schedulerEnabled: true, reconcileIntervalMs: 4567 }
  const row = (name: string, config: unknown) => ({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config })
  const authorityClient = { executable: { path: '/unavailable/client', sha256: 'b'.repeat(64) }, configPath: '/unavailable/authority.json', timeoutMs: 1000 }
  const rows = [row('personal-assistant', { assistantPolicy: policy, assistantAutomations: automations,
    personalMemory: { databasePath: join(home, 'memory.sqlite'), automaticLearning: memory.adoption } }),
  row('assistant-delivery', { databasePath: deliveryPath, defaultWorkspace: owner.workspace, defaultAgentPreset: owner.agentPreset, ownerRoutes: [authority] }),
  row('lark-channel', { enabled: true, account: 'primary', tenant: 'personal' }), row('assistant-memory-learning', memory.learning)]
  if (!options.memoryOnly) rows.push(row('assistant-growth-driver', { enabled: true, intervalMs: 0, budgetId: 'reviews', budgetAmount: 1, scope,
    usageLearning: { enabled: true, databasePath: join(home, 'growth.sqlite'), scanBudgetId: 'discovery', scanBudgetAmount: 1 } }),
  row('plugin-control-plane', { catalogPath: join(home, 'catalog.json'), statePath: join(home, 'control'), trustPath: join(home, 'trust.json'),
    taskObservations: { scope, profilePath: join(home, 'profiles', 'web'), timeoutMs: 300_000, budgetId: 'observations', budgetAmount: 1,
      authority: authorityClient, policy: { id: 'observations', expiresAt: 1, maximumObservations: 1000, minimumChecks: 1, maximumChecks: 32, lookbackMs: 86400000 } },
    liveQualification: { scope, profilePath: join(home, 'profiles', 'web'), timeoutMs: 300_000, budgetId: 'qualification', budgetAmount: 1, authority: authorityClient } }))
  const effectiveConfig = stringify(rows, { aliasDuplicateObjects: false })
  const input = { dshHome: home, profile: 'web', owner, effectiveConfig }
  const derived = deriveScannerRetirementConfiguration(input)
  const definition: HostAutomationDefinition = { name: 'Original scanner', workspace: owner.workspace, agentPreset: owner.agentPreset, principal: owner.principalId,
    schedule: { kind: 'every', anchorAt: '2026-01-01T00:00:00.000Z', intervalMs: 60000 }, timeoutMs: 60000,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    execution: { kind: 'host', executorId: 'original-scanner-v1', executorContractVersion: 1, catalogDigest: 'd'.repeat(64),
      runbookId: 'scan', runbookVersion: 1, targetScope: { workspace: owner.workspace, preset: owner.agentPreset }, scopeDigest: 'f'.repeat(64),
      ownerRouteId: owner.authorityId, activationNonce: 'original' } }
  const writer = new AutomationStore({ path: automationsPath })
  try {
    if (!options.missing) for (const target of derived.targets) writer.reconcileSystemOwned({ ...target, idempotencyKey: target.owner, definition })
    writer.reconcileSystemOwned({ owner: 'ordinary', automationId: 'ordinary', idempotencyKey: 'ordinary', definition })
  } finally { writer.close() }
  history(automationsPath)
  if (options.version === 15) downgrade(automationsPath)
  const context = new Context(), fiber = context.plugin(AssistantPolicyService, { ...policy, proposalMaintenanceIntervalMs: 0 })
  try { await fiber.await() } finally { await fiber.dispose(); await context.fiber.dispose() }
  const before = inspectAutomationRetirementSnapshot(automationsPath)
  return { input, before, deliveryPath, automationsPath, policyPath, derived, rows, definition, capture: () => captureScannerRetirementPlan({ ...input, expectedStorageDigest: before.storageDigest }) }
}
function prepared(f: Awaited<ReturnType<typeof fixture>>): ScannerRetirementPlan {
  const captured = f.capture()
  expect(captured.status).toBe('prepared')
  if (captured.status !== 'prepared') throw new Error('expected prepared stage')
  return captured.plan
}
const apply = (f: Awaited<ReturnType<typeof fixture>>, plan: ScannerRetirementPlan, signal = new AbortController().signal) =>
  applyScannerRetirementPlan({ plan, effectiveConfig: f.input.effectiveConfig, signal })

describe('formal stopped-stage scanner retirement composition', () => {
  test.each([{ version: 15, memoryOnly: false }, { version: 16, memoryOnly: false }, { version: 15, memoryOnly: true }, { version: 16, memoryOnly: true }] as const)(
    'retires exact configured scanners with preserved unknown/history, v$version memoryOnly=$memoryOnly', async options => {
      const f = await fixture(options), policyBefore = policyState(f.policyPath), plan = prepared(f)
      expect(inspectAutomationRetirementSnapshot(f.automationsPath)).toEqual(f.before)
      expect(policyState(f.policyPath)).toEqual(policyBefore)
      expect(plan.targets).toHaveLength(options.memoryOnly ? 1 : 4)
      expect(plan.ownerProof.state.principalVersion).toBe(2)
      expect(plan.ownerProof.frozenPrincipalVersion).toBe(1)
      const intervals = vi.spyOn(globalThis, 'setInterval')
      const completion = await apply(f, plan)
      expect(intervals).not.toHaveBeenCalled()
      expect(completion.after.schemaVersion).toBe(16)
      expect(completion.after.retirements).toHaveLength(plan.targets.length)
      expect(completion.after.historyTables).toEqual(plan.before.historyTables)
      expect(completion.after.records.find(record => record.id === 'ordinary')).toEqual(plan.before.records.find(record => record.id === 'ordinary'))
      expect(verifyScannerRetirementPersistence({ plan, completion })).toEqual(completion.after)
      const policyAfter = policyState(f.policyPath), retire = vi.spyOn(AssistantAutomationsService.prototype, 'retireSystemOwned')
      expect(await apply(f, JSON.parse(JSON.stringify(plan)) as ScannerRetirementPlan)).toEqual(completion)
      expect(retire).not.toHaveBeenCalled()
      expect(policyState(f.policyPath)).toEqual(policyAfter)
      expect(captureScannerRetirementPlan({ ...f.input, expectedStorageDigest: completion.after.storageDigest })).toMatchObject({ status: 'no-op', reason: 'no-targets' })
    })

  test('captures only the new subset, preserving a real existing marker and its original quota', async () => {
    const f = await fixture(), original = prepared(f)
    await applyScannerRetirementMaintenance({ policyConfig: f.derived.policyConfig, automationsConfig: f.derived.automationsConfig,
      operations: [original.operations[0]!], signal: new AbortController().signal })
    const before = inspectAutomationRetirementSnapshot(f.automationsPath)
    const captured = captureScannerRetirementPlan({ ...f.input, expectedStorageDigest: before.storageDigest })
    if (captured.status !== 'prepared') throw new Error('remaining scanner subset must be prepared')
    expect(captured.plan.targets).toHaveLength(3)
    expect(captured.plan.operations).toEqual(original.operations.slice(1))
    const completion = await apply(f, captured.plan)
    expect(completion.after.retirements).toContainEqual(before.retirements[0])
    expect(policyState(f.policyPath).reservations).toHaveLength(4)
  })

  test('retires an existing paused definition at its frozen newer version', async () => {
    const f = await fixture({ memoryOnly: true }), id = f.derived.targets[0]!.automationId
    database(f.automationsPath, db => { db.prepare("UPDATE automation_definitions SET status='paused',next_run_at=NULL,version=version+1 WHERE id=?").run(id) })
    const before = inspectAutomationRetirementSnapshot(f.automationsPath)
    const captured = captureScannerRetirementPlan({ ...f.input, expectedStorageDigest: before.storageDigest })
    if (captured.status !== 'prepared') throw new Error('paused target must be prepared')
    expect(captured.plan.operations[0]!.expectedVersion).toBe(2)
    expect((await apply(f, captured.plan)).after.retirements[0]!.definitionVersion).toBe(3)
  })

  test('returns read-only no-ops for exact active owner and uncreated scanners', async () => {
    const active = await fixture({ active: true })
    expect(active.capture()).toEqual({ status: 'no-op', reason: 'owner-active', effectiveConfigDigest: active.derived.effectiveConfigDigest,
      beforeSnapshotDigest: active.before.snapshotDigest, storageDigest: active.before.storageDigest })
    expect(inspectAutomationRetirementSnapshot(active.automationsPath)).toEqual(active.before)
    const missing = await fixture({ missing: true })
    expect(missing.capture()).toMatchObject({ status: 'no-op', reason: 'no-targets' })
    expect(inspectAutomationRetirementSnapshot(missing.automationsPath)).toEqual(missing.before)
  })

  test.each(['version', 'policy', 'conversation', 'generation', 'missing'] as const)('refuses active-owner no-op when exact %s is unproven', async fault => {
    const f = await fixture({ active: true, minimumGeneration: fault === 'generation' ? 2 : 1 })
    database(f.deliveryPath, db => {
      if (fault === 'version') db.exec('UPDATE delivery_principals SET version=version+1')
      if (fault === 'policy') db.exec("UPDATE conversation_bindings SET policy_ref='other'")
      if (fault === 'missing') db.exec('DELETE FROM conversation_bindings')
      if (fault === 'conversation') {
        const conversation = JSON.stringify({ ...f.derived.ownerQuery.authority.conversation, chat: 'oc_other' })
        db.prepare('UPDATE conversation_bindings SET conversation_json=?,conversation_hash=?').run(conversation, createHash('sha256').update(conversation).digest('hex'))
      }
    })
    expect(f.capture).toThrow()
    expect(inspectAutomationRetirementSnapshot(f.automationsPath)).toEqual(f.before)
  })

  test('rejects wrong attested bytes and a deleted unretired target without opening a writer', async () => {
    const f = await fixture()
    expect(() => captureScannerRetirementPlan({ ...f.input, expectedStorageDigest: 'f'.repeat(64) })).toThrow(/storage-drift/u)
    database(f.automationsPath, db => { db.prepare("UPDATE automation_definitions SET status='deleted',next_run_at=NULL,version=version+1 WHERE id=?").run(f.derived.targets[0]!.automationId) })
    const before = inspectAutomationRetirementSnapshot(f.automationsPath)
    expect(() => captureScannerRetirementPlan({ ...f.input, expectedStorageDigest: before.storageDigest })).toThrow(/invalid-target/u)
  })

  test('resumes the exact original partial tuples without new budget or history', async () => {
    const f = await fixture({ version: 15 }), plan = prepared(f), controller = new AbortController()
    const retire = AssistantAutomationsService.prototype.retireSystemOwned
    vi.spyOn(AssistantAutomationsService.prototype, 'retireSystemOwned').mockImplementationOnce(function (this: AssistantAutomationsService, operation) {
      const result = retire.call(this, operation); controller.abort(new Error('bounded partial stop')); return result
    })
    await expect(apply(f, plan, controller.signal)).rejects.toThrow('bounded partial stop')
    expect(inspectAutomationRetirementSnapshot(f.automationsPath).retirements).toHaveLength(1)
    const completion = await apply(f, plan)
    expect(completion.after.historyTables).toEqual(plan.before.historyTables)
    expect(completion.after.retirements.map(marker => marker.operationId).sort()).toEqual(plan.operations.map(operation => operation.operationId).sort())
    expect(policyState(f.policyPath).reservations).toHaveLength(4)
    expect(verifyScannerRetirementPersistence({ plan, completion }).retirements).toHaveLength(4)
  })

  test('does not manufacture completion after close failure; read-only recovery proves the same original write', async () => {
    const f = await fixture({ memoryOnly: true }), plan = prepared(f), original = AutomationStore.prototype.close
    vi.spyOn(AutomationStore.prototype, 'close').mockImplementationOnce(function (this: AutomationWriter) { original.call(this); throw new Error('close acknowledgement lost') })
    await expect(apply(f, plan)).rejects.toThrow(/lifecycle/u)
    expect(inspectAutomationRetirementSnapshot(f.automationsPath).retirements).toHaveLength(1)
    const retire = vi.spyOn(AssistantAutomationsService.prototype, 'retireSystemOwned')
    const completion = await apply(f, plan)
    expect(retire).not.toHaveBeenCalled()
    expect(completion.after.retirements[0]!.operationId).toBe(plan.operations[0]!.operationId)
    expect(policyState(f.policyPath).reservations).toHaveLength(1)
  })

  test.each([15, 16] as const)('rejects cancellation and Policy denial without completion or retired markers, schema v%i', async version => {
    const f = await fixture({ deny: true, version }), plan = prepared(f), controller = new AbortController()
    controller.abort(new Error('cancel before stage'))
    await expect(apply(f, plan, controller.signal)).rejects.toThrow('cancel before stage')
    expect(inspectAutomationRetirementSnapshot(f.automationsPath)).toEqual(f.before)
    await expect(apply(f, plan)).rejects.toThrow()
    expect(inspectAutomationRetirementSnapshot(f.automationsPath).retirements).toEqual([])
    await expect(apply(f, plan)).rejects.toThrow() // v15 migration alone permits no retirement or new authority.
  })

  test.each(['config', 'proof', 'tuple', 'definition', 'history', 'inode'] as const)('refuses %s drift before further retirement work', async fault => {
    const f = await fixture(), plan = prepared(f), corrupted = structuredClone(plan)
    if (fault === 'config') f.input.effectiveConfig += '\n'
    if (fault === 'proof') database(f.deliveryPath, db => { db.exec('UPDATE delivery_principals SET version=version+1') })
    if (fault === 'tuple') (corrupted.operations[0] as { expectedVersion: number }).expectedVersion++
    if (fault === 'definition') database(f.automationsPath, db => { db.prepare('UPDATE automation_definitions SET version=version+1 WHERE id=?').run(plan.targets[0]!.automationId) })
    if (fault === 'history') history(f.automationsPath, '-drift')
    if (fault === 'inode') { await copyFile(f.automationsPath, `${f.automationsPath}.replacement`); await rename(`${f.automationsPath}.replacement`, f.automationsPath) }
    await expect(apply(f, corrupted)).rejects.toThrow()
    expect(inspectAutomationRetirementSnapshot(f.automationsPath).retirements).toEqual([])
  })

  test('persistence allows subsequent legitimate history and unrelated definitions, using only the frozen path', async () => {
    const f = await fixture(), plan = prepared(f), completion = await apply(f, plan)
    history(f.automationsPath, '-later')
    const writer = new AutomationStore({ path: f.automationsPath })
    try { writer.reconcileSystemOwned({ owner: 'other', automationId: 'new-ordinary', idempotencyKey: 'new-ordinary', definition: f.definition }) } finally { writer.close() }
    const current = verifyScannerRetirementPersistence({ plan, completion })
    expect(current.historyTables).not.toEqual(completion.after.historyTables)
    expect(current.records).toHaveLength(completion.after.records.length + 1)
    expect(current.retirements).toEqual(completion.after.retirements)
  })

  test.each(['marker', 'schema', 'archive', 'inode'] as const)('rejects lost %s persistence evidence', async fault => {
    const f = await fixture(), plan = prepared(f), completion = structuredClone(await apply(f, plan))
    if (fault === 'marker') database(f.automationsPath, db => {
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='automation_retirements_no_delete'").get() as { sql: string }
      db.exec('DROP TRIGGER automation_retirements_no_delete'); db.exec('DELETE FROM automation_system_retirements'); db.exec(sql.sql)
    })
    if (fault === 'schema') downgrade(f.automationsPath)
    if (fault === 'archive') (completion as { completionDigest: string }).completionDigest = createHash('sha256').update('foreign').digest('hex')
    if (fault === 'inode') { await copyFile(f.automationsPath, `${f.automationsPath}.replacement`); await rename(`${f.automationsPath}.replacement`, f.automationsPath) }
    expect(() => verifyScannerRetirementPersistence({ plan, completion })).toThrow()
  })
})
