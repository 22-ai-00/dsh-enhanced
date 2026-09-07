import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'
import { AssistantIsolationService } from '../src/service.ts'
import { defaultLimits } from '../src/config.ts'
import { removeIsolatedContainer, runIsolatedProcess } from '../src/runner.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && process.getuid?.() !== 0 && /^sha256:[0-9a-f]{64}$/.test(image)
const execute = promisify(execFile)
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }
const docker = async (args: string[]) => await execute(dockerPath, ['-H', 'unix:///var/run/docker.sock', ...args], { env, timeout: 15_000, maxBuffer: 16_384 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function run(root: string, name: string, configuredImage = image, executable = dockerPath) {
  return await runIsolatedProcess({ jobId: name.slice('dsh-isolation-'.length), containerName: name, image: configuredImage, dockerPath: executable,
    workspacePath: root, command: 'printf must-not-execute', deadline: Date.now() + 20_000,
    limits: { ...defaultLimits, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64 }, signal: new AbortController().signal, authorizeStart: () => true })
}

test.skipIf(!enabled)('rejects actual image-declared writable volumes before provisioning a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-image-'))
  const name = `dsh-isolation-${randomUUID()}`; const source = `dsh-quota-image-${randomUUID()}`
  let derivedImage: string | undefined
  try {
    await docker(['create', '--pull', 'never', '--name', source, '--entrypoint', '/bin/sh', image, '-c', 'true'])
    derivedImage = (await docker(['commit', '--change', 'VOLUME /unbounded', source])).stdout.trim()
    expect(derivedImage).toMatch(/^sha256:[0-9a-f]{64}$/)
    const result = await run(root, name, derivedImage)
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'docker-create-failed' })
    expect(result.stdout).not.toContain('must-not-execute')
    await expect(docker(['inspect', name])).rejects.toThrow(/No such|no such/)
    await expect(docker(['volume', 'inspect', `${name}-workspace`])).rejects.toThrow(/No such|no such/)
  } finally {
    await removeIsolatedContainer(dockerPath, name)
    await docker(['rm', '-f', source]).catch(() => undefined)
    if (derivedImage !== undefined) await docker(['image', 'rm', derivedImage]).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(!enabled)('retains unknown occupancy when a real volume creation acknowledgment times out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-create-ack-'))
  const stateRoot = join(root, 'state')
  const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
  const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary' }
  const grant = { ...identity, id: 'offline', revision: 1, expiresAt: Date.now() + 120_000, maxRuns: 10, maxTotalDurationMs: 300_000 }
  const reservation = { memoryMiB: 100, workspaceInodes: 64, maxMemoryMiB: 100, maxWorkspaceInodes: 64 }
  ledger.syncGrants([grant])
  const initial = ledger.prepare({ identity, sessionId: 'ambiguous', grantId: grant.id, idempotencyKey: 'before-timeout', requestDigest: 'frozen', durationMs: 20_000, resourceReservation: reservation }).job
  const name = initial.containerName
  let ctx: Context | undefined
  const executable = join(root, 'docker-delay-ack')
  // Create the real volume, then lose the CLI completion acknowledgment. An
  // absent object after cleanup cannot erase the unconfirmed create receipt.
  await writeFile(executable, `#!/bin/sh\nprevious=''\nfor argument in "$@"; do\n  if [ "$previous" = volume ] && [ "$argument" = create ]; then\n    ${quote(dockerPath)} "$@" || exit $?\n    exec sleep 30\n  fi\n  previous="$argument"\ndone\nexec ${quote(dockerPath)} "$@"\n`, { mode: 0o700 })
  try {
    const result = await run(root, name, image, executable)
    expect(result).toMatchObject({ status: 'unknown', quiescent: false, reason: 'docker-creation-unconfirmed' })
    ledger.settle(initial.id, initial.version, { ...result, jobId: initial.id, artifacts: result.artifacts ?? [] })
    ctx = new Context()
    await ctx.plugin(AssistantIsolationService, { stateRoot, image, dockerPath, grants: [] })
    await expect(ctx.assistantIsolation.run(undefined, { grantId: 'offline', idempotencyKey: 'unused', command: 'false' }, new AbortController().signal)).rejects.toThrow()
    expect(ledger.get(initial.id)?.result).toMatchObject({ status: 'unknown', quiescent: false, reason: 'docker-creation-unconfirmed' })
    expect(ledger.recoverable().map(job => job.id)).toContain(initial.id)
    await ctx.fiber.dispose(); ctx = undefined
    ledger.syncGrants([{ ...grant, id: 'after-recovery' }])
    expect(() => ledger.prepare({ identity, sessionId: 'ambiguous', grantId: 'after-recovery', idempotencyKey: 'new', requestDigest: 'new', durationMs: 20_000, resourceReservation: reservation })).toThrow(/pool/)
    expect(result.stdout).not.toContain('must-not-execute')
    await expect(docker(['volume', 'inspect', `${name}-workspace`])).rejects.toThrow(/No such|no such/)
  } finally {
    await ctx?.fiber.dispose()
    ledger.close()
    await removeIsolatedContainer(dockerPath, name)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
