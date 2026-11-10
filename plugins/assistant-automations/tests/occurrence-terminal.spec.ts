import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AutomationCoordinator, type AutomationRunner, type AutomationRunnerResult } from '../src/coordinator.js'
import { AutomationArtifactStore } from '../src/artifacts.js'
import { AutomationStore } from '../src/store.js'
import type { AutomationExecutionDiagnostic } from '../src/types.js'

// Real production coordinator+SQLite with controlled runner results. This proves
// persistence wiring, not native model execution or owner authorization.
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f() })
const scope = { workspace: '/work/terminal', agentPreset: 'primary' }
const success: AutomationExecutionDiagnostic = { schemaVersion: 1, failureClass: 'none', failurePhase: 'none', failureCode: 'none',
  promptSubmissionState: 'submitted', sideEffectState: 'possible', retryability: 'unsafe', budgetSettlementState: 'not-required' }
const failure = (unknown = false): AutomationExecutionDiagnostic => ({ ...success, failureClass: unknown ? 'unknown' : 'execution',
  failurePhase: unknown ? 'unknown' : 'model-execution', failureCode: unknown ? 'runner-unknown' : 'runner-failed' })
function latch() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve }); return { open, promise } }
const runnerFor = (result: Omit<Partial<AutomationRunnerResult>, 'quiescent'> & { quiescent?: boolean | undefined } = {}): AutomationRunner => ({ async run(input) {
  const { quiescent = true, ...rest } = result
  const omitted = Object.hasOwn(result, 'quiescent') && result.quiescent === undefined
  return { outcome: 'succeeded', sessionId: input.sessionId, output: 'private result body', usage: {}, diagnostic: success, ...rest, ...(omitted ? {} : { quiescent }) }
} })
async function fixture(runner = runnerFor()) {
  const root = await mkdtemp(join(tmpdir(), 'occurrence-terminal-')), path = join(root, 'ledger.sqlite')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const at = Date.parse('2026-11-05T10:00:00.000Z'), store = new AutomationStore({ path, now: () => at })
  const coordinator = new AutomationCoordinator({ store, runner, artifacts: new AutomationArtifactStore({ rootPath: join(root, 'artifacts'), maxBytes: 64_000 }),
    ownerId: 'terminal-test', now: () => at, dutyLeaseMs: 10_000, taskLeaseMs: 5_000, misfireGraceMs: 60_000, maxCatchUp: 10, maxConcurrency: 2 })
  let disposed = false
  const dispose = async () => { if (disposed) return; disposed = true; await coordinator.stop(); store.close() }; cleanups.push(dispose)
  store.createApproved({ automationId: 'automation', idempotencyKey: 'create', definition: { name: 'Terminal', prompt: 'private task body', principal: 'owner:terminal', ...scope,
    schedule: { kind: 'at', at: '2030-11-05T10:00:00.000Z' }, provider: 'fixture', model: 'fixture', allowedTools: [], timeoutMs: 30_000,
    maxOutputTokens: 64, maxToolCalls: 0, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0 } })
  let request = 0
  const start = async (dryRun = false) => { const o = store.createManual({ automationId: 'automation', requestId: String(++request), dryRun }); await coordinator.tick(); return o }
  const inspect = (occurrenceId: string) => store.inspectProductionOccurrence({ automationId: 'automation', occurrenceId, ...scope })
  return { path, at, store, coordinator, dispose, start, inspect }
}

test('actual coordinator persists a content-free immutable terminal proof and cold restart retains it', async () => {
  const f = await fixture(), o = await f.start(); await f.coordinator.whenIdle()
  const proof = f.inspect(o.id), run = f.store.listRuns({ limit: 1 })[0]!
  expect(proof).toMatchObject({ protocol: 'assistant-automations/production-occurrence/v1', automationId: 'automation', occurrenceId: o.id,
    runId: run.id, taskId: run.taskId, attemptId: run.attemptId, executionMode: 'production', status: 'succeeded', quiescent: true,
    completedAt: f.at, budgetSettlementState: 'not-required', immutableContext: { state: 'verified', definitionVersion: 1, scope } })
  expect(JSON.stringify(proof)).not.toContain('private'); expect(Object.isFrozen(proof!.immutableContext.scope)).toBe(true)
  await f.dispose(); const cold = new AutomationStore({ path: f.path }); cleanups.push(async () => cold.close())
  expect(cold.inspectProductionOccurrence({ automationId: 'automation', occurrenceId: o.id, ...scope })).toEqual(proof)
})
test.each([{ label: 'omitted', result: { quiescent: undefined } }, { label: 'false', result: { quiescent: false } },
  { label: 'unknown', result: { outcome: 'unknown' as const, diagnostic: failure(true) } }])('never proves $label cleanup', async ({ result }) => {
  const f = await fixture(runnerFor(result)), o = await f.start(); await f.coordinator.whenIdle(); expect(f.inspect(o.id)).toBeUndefined()
})
test.each(['failed', 'cancelled'] as const)('joined %s cleanup remains distinct from business success', async outcome => {
  const diagnostic = outcome === 'failed' ? failure() : { ...failure(), failureClass: 'cancelled' as const, failureCode: 'owner-cancelled' }
  const f = await fixture(runnerFor({ outcome, diagnostic })), o = await f.start(); await f.coordinator.whenIdle()
  expect(f.inspect(o.id)).toMatchObject({ status: outcome, quiescent: true })
})
test('lookup uses exact production occurrence/scope even after a newer preview finishes', async () => {
  const f = await fixture(), o = await f.start(); await f.coordinator.whenIdle(); const p = await f.start(true); await f.coordinator.whenIdle()
  expect(f.inspect(o.id)).toHaveProperty('occurrenceId', o.id); expect(f.inspect(p.id)).toBeUndefined()
  for (const changed of [{ occurrenceId: 'missing' }, { automationId: 'foreign' }, { workspace: '/foreign' }, { agentPreset: 'foreign' }]) {
    expect(f.store.inspectProductionOccurrence({ automationId: 'automation', occurrenceId: o.id, ...scope, ...changed })).toBeUndefined()
  }
})
test('a live runner cannot prove itself or shadow an earlier exact terminal occurrence', async () => {
  const gate = latch(), entered = latch(); let calls = 0
  const f = await fixture({ async run(input) { if (++calls === 2) { entered.open(); await gate.promise } return { outcome: 'succeeded', sessionId: input.sessionId, output: 'done', usage: {}, diagnostic: success, quiescent: true } } })
  const old = await f.start(); await f.coordinator.whenIdle(); const active = await f.start(); await entered.promise
  try { expect(f.inspect(active.id)).toBeUndefined(); expect(f.inspect(old.id)).toHaveProperty('quiescent', true) } finally { gate.open(); await f.coordinator.whenIdle() }
  expect(f.inspect(active.id)).toHaveProperty('quiescent', true)
})
test.each(['snapshot-nul', 'snapshot-invalid-utf8', 'snapshot-bom', 'snapshot-whitespace', 'snapshot-hash', 'diagnostic-nul', 'active-lease'] as const)('persistent %s damage fails closed', async kind => {
  const f = await fixture(), o = await f.start(); await f.coordinator.whenIdle()
  const raw = new DatabaseSync(f.path); cleanups.push(async () => raw.close()); raw.exec('PRAGMA ignore_check_constraints=ON')
  if (kind === 'active-lease') raw.prepare("UPDATE automation_tasks SET status='running',lease_until=? WHERE occurrence_id=?").run(f.at + 60_000, o.id)
  else if (kind === 'diagnostic-nul') raw.prepare("UPDATE automation_runs SET diagnostic_json=CAST(CAST(diagnostic_json AS BLOB)||x'006578747261' AS TEXT) WHERE occurrence_id=?").run(o.id)
  else if (kind === 'snapshot-hash') raw.exec("UPDATE automation_attempts SET automation_snapshot_hash = 'corrupt'")
  else {
    const value = raw.prepare('SELECT automation_snapshot_json AS value FROM automation_attempts').get() as { value: string }, bytes = Buffer.from(value.value)
    const changed = kind === 'snapshot-nul' ? Buffer.concat([bytes, Buffer.from('\0extra')]) : kind === 'snapshot-invalid-utf8' ? Buffer.concat([bytes, Buffer.from([0xff])])
      : kind === 'snapshot-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : Buffer.concat([Buffer.from(' '), bytes])
    raw.prepare('UPDATE automation_attempts SET automation_snapshot_json=CAST(? AS TEXT)').run(changed)
  }
  expect(f.inspect(o.id)).toBeUndefined()
})
test('completion idempotency binds the observation and SQL cannot retroactively rewrite it', async () => {
  const f = await fixture(), o = await f.start(); await f.coordinator.whenIdle()
  const run = f.store.listRuns({ limit: 1 })[0]!, t = f.store.listTasks({ limit: 10 }).find(value => value.id === run.taskId)!
  const input = { taskId: t.id, ownerId: 'terminal-test', fencingToken: t.fencingToken!, now: f.at, outcome: run.status,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }), ...(run.artifactRef === undefined ? {} : { artifactRef: run.artifactRef }), outputPreview: run.outputPreview, usage: run.usage, diagnostic: run.diagnostic }
  expect(() => f.store.completeTask({ ...input, quiescent: true })).not.toThrow(); expect(() => f.store.completeTask(input)).toThrow('different output')
  const raw = new DatabaseSync(f.path); cleanups.push(async () => raw.close())
  expect(() => raw.exec('UPDATE automation_runs SET quiescent=0')).toThrow('immutable'); expect(f.inspect(o.id)).toHaveProperty('quiescent', true)
})
test('real schema16 migration leaves historical runs NULL and prevents later promotion', async () => {
  const f = await fixture(runnerFor({ quiescent: undefined })), o = await f.start(); await f.coordinator.whenIdle(); await f.dispose()
  const raw = new DatabaseSync(f.path); raw.exec('ALTER TABLE automation_task_acceptance DROP COLUMN host_proof_json;DROP TRIGGER automation_run_quiescence_immutable;ALTER TABLE automation_runs DROP COLUMN quiescent;PRAGMA user_version=16;'); raw.close()
  const migrated = new AutomationStore({ path: f.path }); cleanups.push(async () => migrated.close())
  expect(migrated.inspectProductionOccurrence({ automationId: 'automation', occurrenceId: o.id, ...scope })).toBeUndefined()
  const db = new DatabaseSync(f.path); cleanups.push(async () => db.close())
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 18 }); expect(db.prepare('SELECT quiescent FROM automation_runs').get()).toEqual({ quiescent: null })
  expect(() => db.exec('UPDATE automation_runs SET quiescent=1')).toThrow('immutable')
})
