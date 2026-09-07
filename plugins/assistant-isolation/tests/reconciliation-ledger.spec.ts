import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { IsolationLedger, IsolationLedgerError } from '../src/ledger.ts'
import { cleanupIsolationResources, receiptData } from '../src/cleanup-receipt.ts'
import { processWitness } from '../src/runtime-witness.ts'
import type { CreationWitness, DaemonWitness, ProcessWitness } from '../src/runtime-witness.ts'
import type { IsolationGrant, IsolationIdentity, IsolationResult } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const identity: IsolationIdentity = { principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const grant = (id: string, expiresAt: number, maxRuns = 10): IsolationGrant => ({ ...identity, id, revision: 1, expiresAt, maxRuns, maxTotalDurationMs: 10_000 })
const reservation = { memoryMiB: 100, workspaceInodes: 100, maxMemoryMiB: 100, maxWorkspaceInodes: 100 }
const unknown = (jobId: string): IsolationResult => ({ jobId, status: 'unknown', quiescent: false, stdout: 'retained stdout', stderr: 'retained stderr', artifacts: [], reason: 'docker-creation-unconfirmed' })
const error = (fn: () => unknown): IsolationLedgerError => { try { fn() } catch (caught) { expect(caught).toBeInstanceOf(IsolationLedgerError); return caught as IsolationLedgerError }; throw new Error('expected ledger error') }

function databasePath(): string { const root = mkdtempSync(join(tmpdir(), 'reconciliation-ledger-')); roots.push(root); chmodSync(root, 0o700); return join(root, 'ledger.sqlite') }
function daemon(process: ProcessWitness, overrides: Partial<DaemonWitness> = {}): DaemonWitness {
  return { process, engineId: 'engine:1', dockerPath: '/usr/bin/docker', socketPath: '/run/docker.sock', pidFile: '/run/docker.pid', ...overrides }
}
function witness(daemonWitness: DaemonWitness, supervisor: ProcessWitness, requestsSettled: boolean | undefined): CreationWitness {
  return { daemon: daemonWitness, supervisor, ...(requestsSettled === undefined ? {} : { requestsSettled }),
    ...(requestsSettled === false ? { binding: { kind: 'systemd', serviceInvocationId: '0'.repeat(32), socketInvocationId: '1'.repeat(32) } } : {}) }
}

async function childWitness(): Promise<{ child: ReturnType<typeof spawn>; witness: ProcessWitness }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('child did not start')
  const value = await processWitness(child.pid)
  if (!value) throw new Error('child witness unavailable')
  return { child, witness: value }
}

async function stranded(requestsSettled: boolean | undefined): Promise<{ path: string; now: { value: number }; ledger: IsolationLedger; authority: { ownerId: string; fence: number }; job: ReturnType<IsolationLedger['prepare']>['job']; original: CreationWitness; daemonWitness: DaemonWitness; child: ReturnType<typeof spawn> }> {
  const now = { value: Date.now() }; const path = databasePath(); const ledger = new IsolationLedger(path, { now: () => now.value })
  const dockerPath = join(dirname(path), 'docker-cleanup')
  writeFileSync(dockerPath, '#!/bin/sh\ncase " $* " in *" inspect "*) echo "No such object" >&2; exit 1;; *) exit 0;; esac\n', { mode: 0o700 })
  const authority = ledger.claimController('host', 10_000); ledger.syncGrants([grant('first', now.value + 100_000, 1), grant('second', now.value + 100_000)], authority)
  const prepared = ledger.prepare({ identity, sessionId: 'session', grantId: 'first', idempotencyKey: 'first', requestDigest: 'first', durationMs: 1000, resourceReservation: reservation, authority }).job
  const running = ledger.start(prepared.id, prepared.version, authority)
  const current = await processWitness(); if (!current) throw new Error('daemon fixture unavailable')
  const daemonWitness = daemon(current, { dockerPath }); const child = await childWitness(); const original = witness(daemonWitness, child.witness, requestsSettled)
  const job = ledger.settle(running.id, running.version, unknown(running.id), authority, original)
  return { path, now, ledger, authority, job, original, daemonWitness, child: child.child }
}

async function reap(child: ReturnType<typeof spawn>): Promise<void> { child.kill('SIGKILL'); await once(child, 'exit') }
async function receipt(setup: Awaited<ReturnType<typeof stranded>>, name = setup.job.containerName): Promise<object> {
  const executable = join(dirname(setup.path), 'docker-cleanup')
  const value = await cleanupIsolationResources(executable, name, { socketPath: '/run/docker.sock' })
  const data = value && receiptData(value)
  if (!data) throw new Error('cleanup receipt unavailable')
  setup.now.value = Math.max(setup.now.value, data.checkedAt)
  return value
}

describe('reconciled unknown ledger release', () => {
  it('retains an alive supervisor, then releases only after reap while preserving outcome, audit, and grant accounting', async () => {
    const setup = await stranded(true)
    try {
      const cleanup = await receipt(setup); const checkedAt = receiptData(cleanup)!.checkedAt
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup, checkedAt }, setup.authority)).code).toBe('invalid-state')
      await reap(setup.child)
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, checkedAt } as any, setup.authority)).code).toBe('invalid-input')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup: { ...cleanup }, checkedAt } as any, setup.authority)).code).toBe('invalid-input')
      const other = await receipt(setup, 'dsh-isolation-00000000-0000-0000-0000-000000000001')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup: other, checkedAt: receiptData(other)!.checkedAt }, setup.authority)).code).toBe('invalid-input')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: daemon({ ...setup.daemonWitness.process, pid: 1, startTicks: '1' }), cleanup, checkedAt }, setup.authority)).code).toBe('invalid-state')
      const released = setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup, checkedAt }, setup.authority)
      expect(released).toMatchObject({ status: 'unknown', result: { quiescent: true, stdout: 'retained stdout', stderr: 'retained stderr' } })
      expect(setup.ledger.prepare({ identity, sessionId: 'session', grantId: 'second', idempotencyKey: 'after-release', requestDigest: 'after-release', durationMs: 1000, resourceReservation: reservation, authority: setup.authority }).created).toBe(true)
      expect(error(() => setup.ledger.prepare({ identity, sessionId: 'session', grantId: 'first', idempotencyKey: 'counts-remain', requestDigest: 'counts-remain', durationMs: 1, authority: setup.authority })).code).toBe('unauthorized')
      const audit = new DatabaseSync(setup.path)
      expect((audit.prepare("SELECT COUNT(*) AS count FROM isolation_audit WHERE action='job-quiesced'").get() as { count: number }).count).toBe(1)
      expect((audit.prepare("SELECT detail FROM isolation_audit WHERE action='job-quiesced' ORDER BY sequence DESC LIMIT 1").get() as { detail: string }).detail).toContain('requests-settled')
      audit.close()
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup, checkedAt }, setup.authority)).code).toBe('conflict')
      setup.ledger.close()
      const reopened = new IsolationLedger(setup.path, { now: () => 10_000 })
      expect(reopened.get(setup.job.id)).toMatchObject({ status: 'unknown', result: { quiescent: true, stdout: 'retained stdout' }, creationWitness: { requestsSettled: true } })
      reopened.close()
    } finally { if (!setup.child.killed) await reap(setup.child); try { setup.ledger.close() } catch {} }
  })

  it('rejects stale fences and reconciliation proof variants that cannot establish release', async () => {
    const setup = await stranded(true)
    try {
      await reap(setup.child)
      setup.ledger.releaseController(setup.authority); const fresh = setup.ledger.claimController('new-host', 10_000)
      const cleanup = await receipt(setup); const proof = { original: setup.original, current: setup.daemonWitness, cleanup, checkedAt: receiptData(cleanup)!.checkedAt }
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, proof, setup.authority)).code).toBe('unauthorized')
      setup.now.value = proof.checkedAt + 5_001
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, proof, fresh)).code).toBe('invalid-input')
      setup.now.value = proof.checkedAt
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { ...proof, current: daemon(setup.daemonWitness.process, { engineId: 'other:2' }) }, fresh)).code).toBe('invalid-state')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { ...proof, current: daemon(setup.daemonWitness.process, { dockerPath: '/usr/local/bin/docker' }) }, fresh)).code).toBe('invalid-state')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { ...proof, current: daemon(setup.daemonWitness.process, { socketPath: '/run/other.sock' }) }, fresh)).code).toBe('invalid-state')
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { ...proof, original: { ...setup.original, requestsSettled: false } }, fresh)).code).toBe('conflict')
    } finally { if (!setup.child.killed) await reap(setup.child); setup.ledger.close() }
  })

  it.each([undefined, false] as const)('rejects requestsSettled=%s without its required proof', async (requestsSettled) => {
    const setup = await stranded(requestsSettled)
    try {
      await reap(setup.child)
      const cleanup = await receipt(setup)
      expect(error(() => setup.ledger.settleReconciledUnknown(setup.job.id, setup.job.version, { original: setup.original, current: setup.daemonWitness, cleanup, checkedAt: receiptData(cleanup)!.checkedAt }, setup.authority)).code).toBe('invalid-state')
    } finally { if (!setup.child.killed) await reap(setup.child); setup.ledger.close() }
  })
})
