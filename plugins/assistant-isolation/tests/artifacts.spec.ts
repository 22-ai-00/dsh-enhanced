import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultLimits } from '../src/config.ts'
import { runIsolatedProcess } from '../src/runner.ts'
import { normalizeRequest, stageWorkspace } from '../src/workspace.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const enabled = process.platform === 'linux' && process.getuid?.() !== 0 && /^sha256:[0-9a-f]{64}$/.test(image)
const limits = { ...defaultLimits, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64, maxArtifactBytes: 8 }

test.skipIf(!enabled).each([
  ['symlink-parent', 'mkdir real; printf safe > real/file; ln -s real parent', ['parent/file']],
  ['directory', 'mkdir directory', ['directory']],
  ['fifo', 'mkfifo fifo', ['fifo']],
  ['file-size', 'printf 123456789 > big', ['big']],
  ['aggregate-size', 'printf 12345 > a; printf 67890 > b', ['a', 'b']],
])('rejects %s through the real keeper artifact broker', async (_kind, command, artifacts) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-artifact-')); const id = randomUUID()
  try {
    const request = normalizeRequest({ grantId: 'offline', idempotencyKey: id, command: command as string, artifacts: artifacts as string[] }, limits)
    const workspacePath = await stageWorkspace(root, id, request)
    const result = await runIsolatedProcess({ jobId: id, containerName: `dsh-isolation-${id}`, image,
      dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', workspacePath, command: request.command,
      artifacts: request.artifacts ?? [], deadline: Date.now() + 20_000, limits, signal: new AbortController().signal, authorizeStart: () => true })
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'artifact-export-rejected', artifacts: [] })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
