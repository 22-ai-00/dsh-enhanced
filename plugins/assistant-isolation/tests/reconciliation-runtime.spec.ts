import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'
import { reconcileIsolation } from '../src/cli.ts'
import { AssistantIsolationService } from '../src/service.ts'
import { runIsolatedProcess, removeIsolatedContainer } from '../src/runner.ts'
import { processExited } from '../src/runtime-witness.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerTests = /^sha256:[0-9a-f]{64}$/.test(image) ? describe.sequential : describe.skip
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const identity = { principalDigest: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const limits = { maxDurationMs: 30_000, maxInputBytes: 1024, maxOutputBytes: 4096, maxArtifactBytes: 1024, maxFiles: 8,
  memoryMiB: 64, pidsLimit: 32, cpus: 0.5, workspaceMiB: 4, workspaceInodes: 64 }

dockerTests('settled-request reconciliation against real Docker', () => {
  test.each(['operator', 'background'] as const)('%s releases only after exact cleanup, preserving the unknown outcome', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'isolation-reconcile-runtime-')); roots.push(root); await chmod(root, 0o700)
    const flag = join(root, 'deny-removal'); await writeFile(flag, '')
    const dockerPath = join(root, 'docker-wrapper')
    // Only deletion is denied. Every create/start/cp uses the real daemon and normal CLI acknowledgement.
    await writeFile(dockerPath, `#!/bin/sh
if [ -f '${flag}' ]; then
  case " $* " in *" rm "*) echo controlled-removal-denied >&2; exit 42;; esac
fi
exec /usr/bin/docker "$@"
`, { mode: 0o700 })
    const ledger = new IsolationLedger(join(root, 'ledger.sqlite'))
    const authority = ledger.claimController('seed-host', 120_000)
    ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: Date.now() + 120_000, maxRuns: 2, maxTotalDurationMs: 60_000 }], authority)
    let job = ledger.prepare({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'original', requestDigest: 'digest', durationMs: 30_000,
      resourceReservation: { memoryMiB: 100, workspaceInodes: 100, maxMemoryMiB: 100, maxWorkspaceInodes: 100 }, authority }).job
    job = ledger.markDispatched(job.id, job.version, authority)
    const ctx = new Context()
    let handle: { dispose(): Promise<void> } | undefined
    let closed = false
    try {
      const result = await runIsolatedProcess({ jobId: job.id, containerName: job.containerName, image, dockerPath, workspacePath: root,
        command: 'printf retained-output', deadline: job.deadline, limits, signal: new AbortController().signal,
        authorizeStart: () => { job = ledger.start(job.id, job.version, authority); return true } })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'unknown', quiescent: false, creationWitness: { requestsSettled: true } })
      const { creationWitness, ...publicResult } = result
      job = ledger.settle(job.id, job.version, { ...publicResult, jobId: job.id, artifacts: [] }, authority, creationWitness)
      await expect.poll(() => processExited(creationWitness!.supervisor), { timeout: 5000 }).toBe(true)
      const current = job.result
      ledger.releaseController(authority); ledger.close(); closed = true
      const denied = await reconcileIsolation(root, dockerPath)
      expect(denied).toEqual({ checked: 1, released: 0, retained: 1 })
      await rm(flag)
      if (mode === 'operator') {
        const command = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../lib/cli.js', import.meta.url)), 'reconcile', root, dockerPath], { timeout: 15_000, maxBuffer: 16_384, env: { PATH: process.env.PATH, LANG: 'C' } })
        expect(JSON.parse(command.stdout)).toEqual({ checked: 1, released: 1, retained: 0 })
      }
      else {
        handle = await ctx.plugin(AssistantIsolationService, { stateRoot: root, image, dockerPath, grants: [] }) as unknown as { dispose(): Promise<void> }
        await expect(reconcileIsolation(root, dockerPath)).rejects.toThrow(/another host/)
      }
      const db = new DatabaseSync(join(root, 'ledger.sqlite'))
      try {
        await expect.poll(() => JSON.parse((db.prepare('SELECT result_json FROM isolation_jobs WHERE id=?').get(job.id) as { result_json: string }).result_json).quiescent, { timeout: 20_000 }).toBe(true)
        const saved = JSON.parse((db.prepare('SELECT result_json FROM isolation_jobs WHERE id=?').get(job.id) as { result_json: string }).result_json)
        expect(saved).toEqual({ ...current, quiescent: true })
        const details = JSON.parse((db.prepare("SELECT detail FROM isolation_audit WHERE action='job-quiesced' AND job_id=?").get(job.id) as { detail: string }).detail)
        expect(details.cleanup.resources).toHaveLength(3)
        expect(details.mode).toBe('requests-settled')
        expect(db.prepare('SELECT COUNT(*) AS count FROM isolation_jobs').get()).toMatchObject({ count: 1 })
      } finally { db.close() }
    } finally {
      if (!closed) ledger.close()
      await handle?.dispose(); await ctx.fiber.dispose()
      await rm(flag, { force: true })
      expect(await removeIsolatedContainer(dockerPath, job.containerName)).toBe(true)
    }
  }, 90_000)
})
