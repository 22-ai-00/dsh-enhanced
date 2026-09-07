import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'
import { AssistantIsolationService } from '../src/service.ts'
import { removeIsolatedContainer } from '../src/runner.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && process.getuid?.() !== 0 && /^sha256:[0-9a-f]{64}$/.test(image)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const exists = async (path: string) => await access(path).then(() => true, () => false)
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('dispatch fixture did not reach its barrier')
}

test.skipIf(!enabled)('Host death before start cannot release a still-pending real Docker create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dispatch-recovery-'))
  const stateRoot = join(root, 'state')
  const marker = join(root, 'pending')
  const release = join(root, 'release')
  const created = join(root, 'created')
  const executable = join(root, 'docker-barrier')
  await writeFile(executable, `#!/bin/sh
previous=''
for argument in "$@"; do
  if [ "$previous" = volume ] && [ "$argument" = create ]; then
    : > ${quote(marker)}
    attempts=0
    while [ ! -f ${quote(release)} ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 160 ] || exit 1
      sleep 0.05
    done
    ${quote(dockerPath)} "$@" || exit $?
    : > ${quote(created)}
    exit 0
  fi
  previous="$argument"
done
exec ${quote(dockerPath)} "$@"
`, { mode: 0o700 })
  const script = `
    const [ledgerUrl, runnerUrl, root, executable, image] = process.argv.slice(1)
    const { IsolationLedger } = await import(ledgerUrl)
    const { runIsolatedProcess } = await import(runnerUrl)
    const ledger = new IsolationLedger(root + '/state/ledger.sqlite')
    const authority = ledger.claimController('crashed-host', 100)
    const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: root, agentPreset: 'primary' }
    ledger.syncGrants([{ ...identity, id: 'offline', revision: 1, expiresAt: Date.now() + 60000, maxRuns: 10, maxTotalDurationMs: 300000 }], authority)
    const prepared = ledger.prepare({ identity, sessionId: 'crash', grantId: 'offline', idempotencyKey: 'once', requestDigest: 'frozen', durationMs: 20000, authority,
      resourceReservation: { memoryMiB: 100, workspaceInodes: 64, maxMemoryMiB: 100, maxWorkspaceInodes: 64 } }).job
    const job = ledger.markDispatched(prepared.id, prepared.version, authority)
    await runIsolatedProcess({ jobId: job.id, containerName: job.containerName, image, dockerPath: executable, workspacePath: root,
      command: 'printf must-not-execute', deadline: job.deadline,
      limits: { maxDurationMs: 20000, maxInputBytes: 1024, maxOutputBytes: 1024, maxArtifactBytes: 1024, maxFiles: 8, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64, pidsLimit: 16, cpus: 1 },
      signal: new AbortController().signal, authorizeStart: () => { throw new Error('must not reach start') } })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script,
    new URL('../lib/ledger.js', import.meta.url).href, new URL('../lib/runner.js', import.meta.url).href,
    root, executable, image], { detached: true, stdio: 'ignore' })
  let ctx: Context | undefined
  let name: string | undefined
  try {
    await until(async () => await exists(marker))
    const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    try {
      const job = ledger.recoverable()[0]!
      name = job.containerName
      expect(job).toMatchObject({ status: 'prepared', dispatchAttempted: true })
      const exited = once(child, 'exit')
      process.kill(-child.pid!, 'SIGKILL')
      await exited
      ctx = new Context()
      await ctx.plugin(AssistantIsolationService, { stateRoot, image, dockerPath, grants: [] })
      await expect(ctx.assistantIsolation.run(undefined, { grantId: 'offline', idempotencyKey: 'unused', command: 'false' }, new AbortController().signal)).rejects.toThrow()
      expect(await exists(created)).toBe(false)
      expect(ledger.get(job.id)?.result).toMatchObject({ status: 'unknown', quiescent: false, reason: 'controller-recovery-dispatch-unconfirmed' })
      await writeFile(release, '')
      await until(async () => await exists(created))
      // Actual creation occurred after the successor's initial absence check.
      // Even subsequent removal cannot erase this crash ambiguity.
      await ctx.fiber.dispose(); ctx = undefined
      expect(ledger.recoverable().map(value => value.id)).toContain(job.id)
      expect(() => ledger.settle(job.id, ledger.get(job.id)!.version, { ...ledger.get(job.id)!.result!, quiescent: true })).toThrow(/quiescence evidence/)
    } finally { ledger.close() }
  } finally {
    await writeFile(release, '')
    if (child.exitCode === null && child.signalCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    await ctx?.fiber.dispose()
    if (await exists(marker) && !await exists(created)) await until(async () => await exists(created)).catch(() => undefined)
    if (name) await removeIsolatedContainer(dockerPath, name)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
