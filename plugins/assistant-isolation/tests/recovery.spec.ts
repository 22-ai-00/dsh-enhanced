import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'
import { AssistantIsolationService } from '../src/service.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && process.getuid?.() !== 0 && /^sha256:[0-9a-f]{64}$/.test(image)
const execute = promisify(execFile)

test.skipIf(!enabled)('recovery retains a real stranded volume reservation until a later controller confirms removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-recovery-'))
  const stateRoot = join(root, 'state'); const dockerConfig = join(root, 'docker')
  await mkdir(stateRoot, { mode: 0o700 }); await mkdir(dockerConfig, { mode: 0o700 })
  const docker = async (args: string[]) => await execute(dockerPath, ['--config', dockerConfig, '-H', 'unix:///var/run/docker.sock', ...args], {
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, timeout: 10_000, maxBuffer: 16_384,
  })
  const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
  const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary' }
  ledger.syncGrants([{ ...identity, id: 'offline', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 10, maxTotalDurationMs: 300_000 }])
  const initial = ledger.prepare({ identity, sessionId: 'recovery', grantId: 'offline', idempotencyKey: 'do-not-replay', requestDigest: 'frozen-before-crash', durationMs: 30_000,
    resourceReservation: { memoryMiB: 100, workspaceInodes: 64, maxMemoryMiB: 100, maxWorkspaceInodes: 64 } }).job
  ledger.close()
  const name = initial.containerName; const keeper = `${name}-keeper`; const volume = `${name}-workspace`
  let ctx: Context | undefined
  try {
    await docker(['volume', 'create', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=4m,nr_inodes=64,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700,nosuid,nodev`, volume])
    const flags = ['--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${process.getuid!()}:${process.getgid!()}`, '--pids-limit', '16', '--memory', '32m', '--memory-swap', '32m', '--shm-size', '1m',
      '--mount', `type=volume,src=${volume},dst=/workspace,volume-nocopy`, '--entrypoint', '/bin/busybox']
    await docker(['run', '-d', '--name', keeper, ...flags, image, 'sleep', '60'])
    await docker(['run', '-d', '--name', name, ...flags, image, 'sleep', '60'])
    const blockedDocker = join(root, 'docker-retain-volume')
    // A real CLI fault after both containers are removed leaves the actual
    // volume object behind. Unknown cleanup must continue occupying the pool.
    await writeFile(blockedDocker, `#!/bin/sh\nprevious=''\nfor argument in "$@"; do\n  if [ "$previous" = volume ] && [ "$argument" = rm ]; then echo retained-volume-fixture >&2; exit 1; fi\n  previous="$argument"\ndone\nexec '${dockerPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 })
    await chmod(blockedDocker, 0o700)
    ctx = new Context()
    await ctx.plugin(AssistantIsolationService, { stateRoot, image, dockerPath: blockedDocker, grants: [] })
    await expect(ctx.assistantIsolation.run(undefined, { grantId: 'offline', idempotencyKey: 'unused', command: 'false' }, new AbortController().signal)).rejects.toThrow()
    const stranded = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    try {
      expect(stranded.get(initial.id)).toMatchObject({ reservedMemoryMiB: 100, reservedWorkspaceInodes: 64, result: { status: 'unknown', quiescent: false } })
      expect(stranded.recoverable().map(job => job.id)).toEqual([initial.id])
    } finally { stranded.close() }
    await expect(docker(['volume', 'inspect', volume])).resolves.toBeDefined()
    await ctx.fiber.dispose(); ctx = new Context()
    await ctx.plugin(AssistantIsolationService, { stateRoot, image, dockerPath, grants: [] })
    await expect(ctx.assistantIsolation.run(undefined, { grantId: 'offline', idempotencyKey: 'unused', command: 'false' }, new AbortController().signal)).rejects.toThrow()
    const recovered = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    try {
      expect(recovered.get(initial.id)?.result).toMatchObject({ status: 'unknown', quiescent: true, reason: 'controller-recovery-no-replay' })
      expect(recovered.recoverable()).toEqual([])
    } finally { recovered.close() }
    for (const [type, resource] of [['container', name], ['container', keeper], ['volume', volume]]) {
      await expect(docker(['inspect', '--type', type!, resource!])).rejects.toThrow(/No such|no such/)
    }
  } finally {
    await ctx?.fiber.dispose()
    await docker(['rm', '-f', name, keeper]).catch(() => undefined)
    await docker(['volume', 'rm', volume]).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
