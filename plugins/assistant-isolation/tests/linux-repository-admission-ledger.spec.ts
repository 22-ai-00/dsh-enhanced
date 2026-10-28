import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { IsolationLedger, IsolationLedgerError } from '../src/ledger.js'
import { consumeLinuxLedgerAdmissionRefusal, withLinuxLedgerAdmissionAttempt } from '../src/linux-repository-admission.js'
import * as admission from '../src/linux-repository-admission.js'
import type { LinuxExecutionContract } from '../src/linux-execution-contract.js'

const ledgers: IsolationLedger[] = []
afterEach(() => { vi.restoreAllMocks(); for (const ledger of ledgers.splice(0)) ledger.close() })
const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', profile: 'ordinary', runtimeDigest: 'b'.repeat(64),
  limits: { maxDurationMs: 1000, maxInputBytes: 1024, maxOutputBytes: 1024, maxArtifactBytes: 1024, maxFiles: 8,
    memoryMiB: 64, workspaceMiB: 16, workspaceInodes: 128, pidsLimit: 16, cpus: 1 },
  keeperLimits: { memoryMiB: 32, pidsLimit: 8, cpus: 0.1 },
  cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1001', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1001',
    pids: '/sys/fs/cgroup/pids/dsh-native/uid-1001', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1001' } }
function fixture() {
  const ledger = new IsolationLedger(':memory:', { now: () => 10000 }); ledgers.push(ledger)
  const authority = ledger.claimController('host', 1000)
  ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: 100000, maxRuns: 1, maxTotalDurationMs: 1000 }], authority)
  const input = { identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'key', requestDigest: 'c'.repeat(64), durationMs: 500,
    backend: 'linux-native' as const, linuxContract: contract, authority,
    resourceReservation: { memoryMiB: 112, workspaceInodes: 128, maxMemoryMiB: 224, maxWorkspaceInodes: 256 },
    storageBudget: { maxStateBytes: 100000, maxJobRecords: 10, reservedBytes: 4096, observation: { bytes: 0, observedAt: 10000 } } }
  const attempt = {}, binding = { ledger, authority, attempt, key: input.idempotencyKey, requestDigest: input.requestDigest }
  return { ledger, input, attempt, binding }
}
function failure(operation: () => unknown): unknown { try { operation() } catch (error) { return error }; throw new Error('expected refusal') }

test.each(['budget', 'storage', 'missing-observation', 'stale-observation'] as const)('only a rolled-back canonical %s refusal has single-use evidence', kind => {
  const f = fixture()
  if (kind === 'budget') f.ledger.prepare({ ...f.input, idempotencyKey: 'spent' })
  if (kind === 'storage') f.input.storageBudget.maxStateBytes = 1
  if (kind === 'missing-observation') delete (f.input.storageBudget as { observation?: unknown }).observation
  if (kind === 'stale-observation') f.input.storageBudget.observation.observedAt = 1
  const error = failure(() => withLinuxLedgerAdmissionAttempt(f.ledger, f.attempt, () => f.ledger.prepare(f.input)))
  expect(error).toBeInstanceOf(IsolationLedgerError)
  expect(consumeLinuxLedgerAdmissionRefusal(error, { ...f.binding, ledger: {} })).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(error, { ...f.binding, key: 'other' })).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(error, { ...f.binding, requestDigest: 'd'.repeat(64) })).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(error, { ...f.binding, authority: { ...f.binding.authority, fence: 2 } })).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(error, { ...f.binding, attempt: {} })).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(error, f.binding)).toBe(true)
  expect(consumeLinuxLedgerAdmissionRefusal(error, f.binding)).toBe(false)
  expect(f.ledger.findJobByKey(identity, 'session', 'grant', 'key')).toBeUndefined()
})

test.each(['query', 'insert', 'commit', 'rollback', 'existing'] as const)('%s uncertainty or historical input cannot mint refusal evidence', stage => {
  const f = fixture(), exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare
  if (stage === 'existing') f.ledger.prepare(f.input)
  if (stage === 'rollback') { f.ledger.prepare({ ...f.input, idempotencyKey: 'spent' }); vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'ROLLBACK') throw new Error('injected rollback failed')
    return exec.call(this, sql)
  }) }
  if (stage === 'commit') vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    const result = exec.call(this, sql)
    if (sql === 'COMMIT') throw new Error('injected commit acknowledgement lost')
    return result
  })
  if (stage === 'query' || stage === 'insert') vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    if (stage === 'query' && sql.includes('COUNT(*) AS runs') || stage === 'insert' && sql.startsWith('INSERT INTO isolation_jobs(')) {
      throw new IsolationLedgerError('unauthorized', 'grant budget exhausted')
    }
    return prepare.call(this, sql)
  })
  const error = failure(() => withLinuxLedgerAdmissionAttempt(f.ledger, f.attempt, () => f.ledger.prepare(stage === 'existing' ? { ...f.input, requestDigest: 'd'.repeat(64) } : f.input)))
  expect(consumeLinuxLedgerAdmissionRefusal(error, f.binding)).toBe(false)
  expect(consumeLinuxLedgerAdmissionRefusal(new IsolationLedgerError('unauthorized', 'grant budget exhausted'), f.binding)).toBe(false)
  vi.restoreAllMocks()
  if (stage === 'commit') expect(f.ledger.findJobByKey(identity, 'session', 'grant', 'key')).toBeDefined()
})


test('a failed proof bookkeeping callback preserves the original rejection and cannot mint evidence', () => {
  const f = fixture()
  f.ledger.prepare({ ...f.input, idempotencyKey: 'spent' })
  vi.spyOn(admission, 'markLinuxLedgerAdmissionRefusal').mockImplementationOnce(() => { throw new Error('proof bookkeeping failed') })
  const error = failure(() => withLinuxLedgerAdmissionAttempt(f.ledger, f.attempt, () => f.ledger.prepare(f.input)))
  expect(error).toBeInstanceOf(IsolationLedgerError)
  expect((error as Error).message).toBe('grant budget exhausted')
  expect(consumeLinuxLedgerAdmissionRefusal(error, f.binding)).toBe(false)
})
