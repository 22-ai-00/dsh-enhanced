import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLimits } from './config.js'
import { runIsolatedProcess } from './runner.js'
import { stageWorkspace } from './workspace.js'

/** Operator-only readiness probe using the same supervisor and work-volume path as jobs. */
export async function probeIsolationRuntime(image: string, dockerPath = '/usr/bin/docker'): Promise<{ ready: true }> {
  if (!/^sha256:[0-9a-f]{64}$/.test(image) || !dockerPath.startsWith('/')) throw new Error('isolation readiness requires an immutable local image and absolute Docker path')
  if (process.platform !== 'linux' || process.getuid?.() === undefined || process.getuid() === 0) throw new Error('isolation readiness requires a non-root Linux Host and Docker access')
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-isolation-probe-'))
  const jobId = randomUUID(); const containerName = `dsh-isolation-${jobId}`
  let safeToRemove = true
  try {
    const marker = randomUUID()
    const command = `test "$(id -u)" != 0 && test ! -w /etc && printf '%s' '${marker}' > readiness.txt && printf '%s' '${marker}'`
    const workspacePath = await stageWorkspace(stateRoot, jobId, { grantId: 'readiness', idempotencyKey: jobId, command })
    await writeFile(join(stateRoot, 'probe.json'), JSON.stringify({ jobId, containerName, image, dockerPath }), { mode: 0o600, flag: 'wx' })
    safeToRemove = false
    const result = await runIsolatedProcess({ jobId, containerName, image, dockerPath, workspacePath,
      command, artifacts: ['readiness.txt'], deadline: Date.now() + 20_000,
      limits: { ...defaultLimits, maxDurationMs: 20_000, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64 },
      signal: AbortSignal.timeout(20_000), authorizeStart: () => true })
    safeToRemove = result.quiescent
    if (result.status !== 'succeeded' || !result.quiescent || result.stdout !== marker
      || result.artifacts?.length !== 1 || result.artifacts[0]?.content !== marker) {
      throw new Error(`isolation readiness failed (${result.reason ?? result.status}); check Docker permissions, local image and resource limits${safeToRemove ? '' : `; unresolved probe evidence retained at ${stateRoot}`}`)
    }
    return { ready: true }
  } catch (error) {
    if (!safeToRemove) throw new Error(`isolation readiness did not establish quiescence; unresolved probe evidence retained at ${stateRoot}`, { cause: error })
    throw error
  } finally { if (safeToRemove) await rm(stateRoot, { recursive: true, force: true }) }
}
