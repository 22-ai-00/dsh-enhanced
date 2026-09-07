import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { IsolatedVerifierRunner, type IsolatedVerifierRunnerConfig } from '../src/verifier-runner.ts'
import { IsolationLedger } from '../src/ledger.ts'
import { defaultLimits } from '../src/config.ts'
import { normalizeRequest } from '../src/workspace.ts'

// Real Docker only: the runner never pulls. CI and local unit runs skip this
// suite unless the operator supplies an already-present immutable image.
const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const dockerTests = process.platform === 'linux' && process.getuid?.() !== 0 && /^sha256:[0-9a-f]{64}$/.test(image) ? describe.sequential : describe.skip
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dsh-verifier-runner-')); await chmod(value, 0o700); roots.push(value); return value }
function config(stateRoot: string, changes: Partial<IsolatedVerifierRunnerConfig> = {}): IsolatedVerifierRunnerConfig {
  return {
    stateRoot, image, dockerPath, authorityDigest: 'a'.repeat(64), command: '/bin/sh /workspace/artifact < /workspace/input',
    expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 10_000, maxOutputBytes: 4_096,
    ...changes,
  }
}

dockerTests('isolated verifier runner (opt in)', () => {
  test('runs an immutable local image, preserves behavior output, and returns the exact idempotent result', async () => {
    const stateRoot = await root(); const options = config(stateRoot); const runner = new IsolatedVerifierRunner(options)
    options.command = 'printf changed-after-admission'; options.maxRuns = 100
    try {
      const artifact = '#!/bin/sh\nprintf "seen:%s" "$(cat)"\n'
      const first = await runner.run('case-1', artifact, 'input-1', new AbortController().signal)
      expect(first).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'seen:input-1' })
      const repeat = await runner.run('case-1', artifact, 'input-1', new AbortController().signal)
      expect(repeat).toEqual(first)
      const wrongBehavior = await runner.run('case-2', '#!/bin/sh\nprintf wrong\n', 'input-2', new AbortController().signal)
      expect(wrongBehavior).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'wrong' })
    } finally { await runner.close() }
  }, 60_000)

  test('reserves finite run budget and settles cancellation before close', async () => {
    const stateRoot = await root(); const runner = new IsolatedVerifierRunner(config(stateRoot, { maxRuns: 1 }))
    try {
      const controller = new AbortController()
      const pending = runner.run('cancelled', '#!/bin/sh\nsleep 30\n', '', controller.signal)
      const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        await expect.poll(() => database.prepare("SELECT status FROM isolation_jobs WHERE idempotency_key='cancelled'").get()?.status, { timeout: 15000 }).toBe('running')
      } finally { database.close() }
      controller.abort()
      await expect(pending).resolves.toMatchObject({ status: 'cancelled', quiescent: true })
      await expect(runner.run('budget-exhausted', '#!/bin/sh\nprintf no\n', '', new AbortController().signal)).rejects.toThrow(/budget|unauthorized/i)
      await runner.close()
      await expect(runner.close()).resolves.toBeUndefined()
    } finally { await runner.close() }
  }, 60_000)

  test('reopens dispatched work as durable unknown and never replays the same key', async () => {
    const stateRoot = await root(); const options = config(stateRoot)
    const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    const identity = { principalDigest: options.authorityDigest, principalRecordId: `verification:${options.authorityDigest}`, principalVersion: 1, workspace: stateRoot, agentPreset: 'verification' }
    const controller = ledger.claimController('predecessor', 30_000)
    ledger.syncGrants([{ ...identity, id: 'verification', revision: 1, expiresAt: options.expiresAt, maxRuns: options.maxRuns, maxTotalDurationMs: options.maxTotalDurationMs }], controller)
    const request = normalizeRequest({ grantId: 'verification', idempotencyKey: 'replay-key', command: options.command, files: [{ path: 'artifact', content: '#!/bin/sh\nprintf should-not-run\n' }, { path: 'input', content: '' }], artifacts: [], timeoutMs: options.maxDurationMs }, { ...defaultLimits, maxDurationMs: options.maxDurationMs, maxOutputBytes: options.maxOutputBytes })
    const digest = createHash('sha256').update(JSON.stringify({ request, authority: options.authorityDigest })).digest('hex')
    const prepared = ledger.prepare({ identity, sessionId: `authority:${options.authorityDigest}`, grantId: 'verification', idempotencyKey: 'replay-key', requestDigest: digest, durationMs: options.maxDurationMs, authority: controller }).job
    ledger.markDispatched(prepared.id, prepared.version, controller); ledger.releaseController(controller); ledger.close()
    const runner = new IsolatedVerifierRunner(options)
    try {
      const result = await runner.run('replay-key', '#!/bin/sh\nprintf should-not-run\n', '', new AbortController().signal)
      expect(result).toMatchObject({ status: 'unknown', quiescent: false, reason: 'verification-recovery-no-replay' })
    } finally { await runner.close() }
  }, 60_000)
})
