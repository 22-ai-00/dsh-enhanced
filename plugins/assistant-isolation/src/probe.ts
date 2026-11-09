import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from './config.js'
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
