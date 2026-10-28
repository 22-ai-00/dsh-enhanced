import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { defaultStoragePolicy, plannedStorageBytes, validateStoragePolicy } from './storage-policy.js'
import { configuredDockerSocketPath } from './docker-socket.js'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { linuxJobResourceReservation, validateLinuxExecutionContract } from './linux-execution-contract.js'
import { linuxRuntimeDigest, validateLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'
import type { IsolationGrant, IsolationLimits, IsolationStoragePolicy } from './types.js'

export interface Config {
  backend?: 'docker' | 'linux-native'
  linux?: { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }
  stateRoot?: string
  image?: string
  dockerPath?: string
  socketPath?: string
  grants?: IsolationGrant[]
  limits?: Partial<IsolationLimits>
  storage?: Partial<IsolationStoragePolicy>
  maxConcurrentJobs?: number
  maxReservedMemoryMiB?: number
  maxReservedWorkspaceInodes?: number
}
export const defaultLimits: IsolationLimits = { maxDurationMs: 60_000, maxInputBytes: 1_048_576,
  maxOutputBytes: 65_536, maxArtifactBytes: 262_144, maxFiles: 32, memoryMiB: 256, workspaceMiB: 64, workspaceInodes: 4096, pidsLimit: 64, cpus: 1 }
const integer = (max: number) => Schema.number().step(1).min(1).max(max)
const configShape: Schema<Config> = Schema.object({
  backend: Schema.union(['docker', 'linux-native']).default('docker'),
  linux: Schema.any(),
  stateRoot: Schema.string().default(join(homedir(), '.dsh', 'assistant-isolation')),
  image: Schema.string(), dockerPath: Schema.string().default(process.platform === 'darwin' ? '/usr/local/bin/docker' : '/usr/bin/docker'),
  socketPath: Schema.string(),
  grants: Schema.array(Schema.object({
    id: Schema.string().required(), revision: integer(Number.MAX_SAFE_INTEGER).required(),
    principalDigest: Schema.string().required(), principalRecordId: Schema.string().required(),
    principalVersion: integer(Number.MAX_SAFE_INTEGER).required(), workspace: Schema.string().required(), agentPreset: Schema.string().required(),
    expiresAt: integer(Number.MAX_SAFE_INTEGER).required(), maxRuns: integer(1_000_000).required(),
    maxTotalDurationMs: integer(Number.MAX_SAFE_INTEGER).required(),
  })).default([]),
  limits: Schema.object({ maxDurationMs: integer(300_000), maxInputBytes: integer(1_048_576),
    maxOutputBytes: integer(262_144), maxArtifactBytes: integer(1_048_576), maxFiles: integer(128),
    workspaceMiB: integer(1024), workspaceInodes: integer(65_536), memoryMiB: integer(4096), pidsLimit: integer(512), cpus: Schema.number().min(0.1).max(8) }),
  storage: Schema.object({ maxStateBytes: integer(16 * 1024 * 1024 * 1024), maxJobRecords: integer(1_000_000), resultRetentionMs: Schema.number().step(1).min(0).max(365 * 24 * 60 * 60 * 1000) }),
  maxConcurrentJobs: integer(16).default(2),
  maxReservedMemoryMiB: integer(65_536).default(2048),
  maxReservedWorkspaceInodes: integer(1_048_576).default(32_768),
})
export type ValidatedConfig = Required<Omit<Config, 'linux' | 'limits' | 'storage'>> & {
  linux?: { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }; limits: IsolationLimits; storage: IsolationStoragePolicy
}
export function validateConfig(input: Config): ValidatedConfig {
  input = configShape(input)
  const backend = input.backend ?? 'docker'
  const stateRoot = input.stateRoot ?? join(homedir(), '.dsh', 'assistant-isolation')
  const dockerPath = input.dockerPath ?? (process.platform === 'darwin' ? '/usr/local/bin/docker' : '/usr/bin/docker')
  const socketPath = backend === 'docker' ? configuredDockerSocketPath(input.socketPath) : input.socketPath ?? ''
  const grants = structuredClone(input.grants ?? [])
  const image = input.image ?? ''
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || stateRoot === '/' || /[\p{Cc},]/u.test(stateRoot)
    || backend === 'docker' && (!isAbsolute(dockerPath) || resolve(dockerPath) !== dockerPath)) throw new Error('assistant-isolation: canonical absolute paths required')
  if (backend === 'docker' && ((image !== '' && !/^sha256:[0-9a-f]{64}$/.test(image)) || (grants.length > 0 && image === ''))) throw new Error('assistant-isolation: grants require an immutable local image ID')
  const limits = { ...defaultLimits, ...input.limits }
  const storage = validateStoragePolicy({ ...defaultStoragePolicy, ...input.storage })
  const maxima: IsolationLimits = { maxDurationMs: 300_000, maxInputBytes: 1_048_576, maxOutputBytes: 262_144,
    maxArtifactBytes: 1_048_576, maxFiles: 128, memoryMiB: 4096, workspaceMiB: 1024, workspaceInodes: 65_536, pidsLimit: 512, cpus: 8 }
  for (const key of Object.keys(limits) as Array<keyof IsolationLimits>) {
    if (!(key in maxima) || !Number.isFinite(limits[key]) || limits[key] <= 0 || limits[key] > maxima[key]
      || (key !== 'cpus' && !Number.isSafeInteger(limits[key])) || (key === 'cpus' && limits[key] < 0.1)) throw new Error('assistant-isolation: invalid limits')
  }
  const maxConcurrentJobs = input.maxConcurrentJobs ?? 2
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 16) throw new Error('assistant-isolation: invalid concurrency')
  let linux: ValidatedConfig['linux']
  let requiredMemory = limits.memoryMiB + limits.workspaceMiB + 32
  let requiredInodes = limits.workspaceInodes
  let requiredStorage = plannedStorageBytes(limits)
  if (backend === 'linux-native') {
    if (process.platform !== 'linux' || !process.getuid?.() || stateRoot.includes('\\') || !input.linux
      || Object.keys(input.linux).sort().join() !== 'cgroupRoots,runtime') throw new Error('assistant-isolation: Linux native runtime and cgroup roots required')
    const runtime = validateLinuxRuntime(input.linux.runtime)
    if (runtime.root.path === stateRoot || runtime.root.path.startsWith(stateRoot + sep)
      || stateRoot.startsWith(runtime.root.path + sep)) throw new Error('assistant-isolation: state overlaps Linux runtime')
    const contract = validateLinuxExecutionContract({ schemaVersion: 1, backend, runtimeDigest: linuxRuntimeDigest(runtime),
      profile: 'ordinary', limits, keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: input.linux.cgroupRoots })
    if (contract.cgroupRoots.mode !== 'v1' || Object.entries(contract.cgroupRoots).some(([key, value]) => key !== 'mode'
      && !value.endsWith(`/uid-${process.getuid!()}`))) throw new Error('assistant-isolation: Linux native requires current-user cgroup v1 roots')
    linux = { runtime, cgroupRoots: contract.cgroupRoots }
    const reservation = linuxJobResourceReservation(contract)
    requiredMemory = reservation.memoryMiB; requiredInodes = reservation.workspaceInodes; requiredStorage = reservation.storageBytes
  } else if (input.linux !== undefined) throw new Error('assistant-isolation: Linux configuration requires linux-native backend')
  const maxReservedMemoryMiB = input.maxReservedMemoryMiB ?? 2048
  const maxReservedWorkspaceInodes = input.maxReservedWorkspaceInodes ?? 32_768
  if (!Number.isSafeInteger(maxReservedMemoryMiB) || maxReservedMemoryMiB < requiredMemory || maxReservedMemoryMiB > 65_536
    || !Number.isSafeInteger(maxReservedWorkspaceInodes) || maxReservedWorkspaceInodes < requiredInodes || maxReservedWorkspaceInodes > 1_048_576) throw new Error('assistant-isolation: invalid resource pool')
  for (const grant of grants) if (!isAbsolute(grant.workspace) || resolve(grant.workspace) !== grant.workspace
    || !/^[0-9a-f]{64}$/.test(grant.principalDigest)) throw new Error('assistant-isolation: invalid grant scope')
  if (storage.maxStateBytes < requiredStorage) throw new Error('assistant-isolation: storage budget below planned job allocation')
  return { backend, ...(linux ? { linux } : {}), stateRoot, dockerPath, socketPath, image, grants, limits, storage, maxConcurrentJobs, maxReservedMemoryMiB, maxReservedWorkspaceInodes }
}

/** Loader and direct callers share the same synchronous admission checks. */
export const Config: Schema<Config> = Schema.transform(Schema.any(), (value, options) => {
  try { return validateConfig(value) }
  catch (error) { throw new Schema.ValidationError(String(error), options ?? { path: [] }) }
}) as Schema<Config>
