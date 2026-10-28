import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLimits, validateConfig } from './config.js'
import { configuredDockerSocketPath } from './docker-socket.js'
import { runIsolatedProcess } from './runner.js'
import { stageWorkspace } from './workspace.js'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { linuxRuntimeDigest, verifyLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'
import { validateLinuxExecutionContract } from './linux-execution-contract.js'
import { prepareLinuxExecutionIntent, runLinuxExecution, readLinuxExecutionReceipt, readLinuxExecutionPartialCleanupProof } from './linux-execution.js'

export interface LinuxIsolationProbeConfig { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }

/** One finite operator probe. It neither creates owner grants nor contacts Docker. */
export async function probeLinuxIsolationRuntime(input: LinuxIsolationProbeConfig): Promise<{ ready: true }> {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join() !== 'cgroupRoots,runtime') throw new Error('native probe requires runtime and cgroupRoots')
  const config = validateConfig({ backend: 'linux-native', linux: input,
    limits: { maxDurationMs: 20_000, memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 64 } })
  if (!config.linux) throw new Error('native probe configuration unavailable')
  const runtime = config.linux.runtime
  await verifyLinuxRuntime(runtime)
  const contract = validateLinuxExecutionContract({ schemaVersion: 1, backend: 'linux-native',
    runtimeDigest: linuxRuntimeDigest(runtime), profile: 'ordinary', limits: config.limits,
    keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: config.linux.cgroupRoots })
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-native-isolation-probe-'))
  const jobId = randomUUID(), marker = randomUUID()
  let safeToRemove = true
  try {
    const intent = await prepareLinuxExecutionIntent({ stateRoot, contract, job: { id: jobId,
      requestDigest: linuxRuntimeDigest(runtime), nativeResourceId: `linux-${jobId}`, nativeNonce: randomBytes(16).toString('hex'),
      deadline: Date.now() + 20_000 } })
    const context = { stateRoot, contract, intent }
    safeToRemove = false
    await writeFile(join(stateRoot, 'probe.json'), JSON.stringify({ backend: 'linux-native', contract, intent }), { mode: 0o600, flag: 'wx' })
    const command = `test "$(id -u)" = 65534 && test ! -w /etc && printf '%s' '${marker}' > readiness.txt && printf '%s:' '${marker}' && node -e 'process.stdout.write(process.version)'`
    await runLinuxExecution({ ...context,
      argv: ['/bin/sh', '-c', 'PATH=/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin; export PATH; exec /bin/sh -c "$1"', 'dsh-native-probe', command],
      files: [], artifacts: ['readiness.txt'], readOnlyRoots: [runtime.root.path], signal: AbortSignal.timeout(20_000),
      recordResources: async () => {}, authorizeStart: () => true })
    const receipt = await readLinuxExecutionReceipt(context)
    safeToRemove = receipt?.result.quiescent === true || !!await readLinuxExecutionPartialCleanupProof(context)
    const result = receipt?.result
    if (result?.status !== 'succeeded' || !safeToRemove || result.stdout !== `${marker}:${runtime.versions.node}`
      || result.artifacts.length !== 1 || result.artifacts[0]?.path !== 'readiness.txt' || result.artifacts[0]?.content !== marker) {
      throw new Error(`native isolation readiness failed (${result?.reason ?? result?.status ?? 'receipt-unavailable'})`)
    }
    return { ready: true }
  } catch (error) {
    if (!safeToRemove) throw new Error(`native isolation readiness did not establish quiescence; unresolved probe evidence retained at ${stateRoot}`, { cause: error })
    throw error
  } finally { if (safeToRemove) await rm(stateRoot, { recursive: true, force: true }) }
}

/** Operator-only readiness probe using the same supervisor and work-volume path as jobs. */
export async function probeIsolationRuntime(image: string, dockerPath = process.platform === 'darwin' ? '/usr/local/bin/docker' : '/usr/bin/docker', socketPath?: string): Promise<{ ready: true }> {
  if (!/^sha256:[0-9a-f]{64}$/.test(image) || !dockerPath.startsWith('/')) throw new Error('isolation readiness requires an immutable local image and absolute Docker path')
  if (!['linux', 'darwin'].includes(process.platform) || process.getuid?.() === undefined || process.getuid() === 0) throw new Error('isolation readiness requires a non-root Unix Host and Docker access')
  socketPath = configuredDockerSocketPath(socketPath)
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-isolation-probe-'))
  const jobId = randomUUID(); const containerName = `dsh-isolation-${jobId}`
  let safeToRemove = true
  try {
    const marker = randomUUID()
    const command = `test "$(id -u)" != 0 && test ! -w /etc && printf '%s' '${marker}' > readiness.txt && printf '%s' '${marker}'`
    const workspacePath = await stageWorkspace(stateRoot, jobId, { grantId: 'readiness', idempotencyKey: jobId, command })
    await writeFile(join(stateRoot, 'probe.json'), JSON.stringify({ jobId, containerName, image, dockerPath, socketPath }), { mode: 0o600, flag: 'wx' })
    safeToRemove = false
    const result = await runIsolatedProcess({ jobId, containerName, image, dockerPath, socketPath, workspacePath,
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
