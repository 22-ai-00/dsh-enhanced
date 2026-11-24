import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { posix, sep, win32 } from 'node:path'
import { canonicalAbsolutePath, isPathWithinOrEqual } from './fs-ownership.js'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { linuxJobResourceReservation, validateLinuxExecutionContract } from './linux-execution-contract.js'
import { linuxRuntimeDigest, validateLinuxRuntime, type LinuxRuntime } from './linux-runtime.js'
import { validateNativeMacRuntime, type NativeMacRuntime } from './native-runtime.js'
import { resolveIsolationBackend, type IsolationBackend, type IsolationBackendConfig } from './platform.js'
import { defaultStoragePolicy, plannedStorageBytes, validateStoragePolicy } from './storage-policy.js'
import type { IsolationGrant, IsolationLimits, IsolationStoragePolicy } from './types.js'

export interface MacosIsolationConfig {
  runtime?: NativeMacRuntime
  readOnlyRoots?: string[]
  sandboxExecPath?: string
}

export interface WindowsIsolationConfig {
  powershellPath?: string
  shell?: 'cmd' | 'powershell'
  shellPath?: string
}

export interface Config {
  backend?: IsolationBackendConfig
  linux?: { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }
  macos?: MacosIsolationConfig
  windows?: WindowsIsolationConfig
  stateRoot?: string
  grants?: IsolationGrant[]
  limits?: Partial<IsolationLimits>
  storage?: Partial<IsolationStoragePolicy>
  maxConcurrentJobs?: number
  maxReservedMemoryMiB?: number
  maxReservedWorkspaceInodes?: number
}

export const defaultLimits: IsolationLimits = {
  maxDurationMs: 60_000,
  maxInputBytes: 1_048_576,
  maxOutputBytes: 65_536,
  maxArtifactBytes: 262_144,
  maxFiles: 32,
  memoryMiB: 256,
  workspaceMiB: 64,
  workspaceInodes: 4096,
  pidsLimit: 64,
  cpus: 1,
}

const integer = (max: number) => Schema.number().step(1).min(1).max(max)
const configShape: Schema<Config> = Schema.object({
  backend: Schema.union([
    Schema.const('auto'),
    Schema.const('linux-native'),
    Schema.const('macos-seatbelt'),
    Schema.const('windows-job'),
  ]).default('auto'),
  linux: Schema.any(),
  macos: Schema.any(),
  windows: Schema.any(),
  stateRoot: Schema.string(),
  grants: Schema.array(Schema.object({
    id: Schema.string().required(),
    revision: integer(Number.MAX_SAFE_INTEGER).required(),
    principalDigest: Schema.string().required(),
    principalRecordId: Schema.string().required(),
    principalVersion: integer(Number.MAX_SAFE_INTEGER).required(),
    workspace: Schema.string().required(),
    agentPreset: Schema.string().required(),
    expiresAt: integer(Number.MAX_SAFE_INTEGER).required(),
    maxRuns: integer(1_000_000).required(),
    maxTotalDurationMs: integer(Number.MAX_SAFE_INTEGER).required(),
  })).default([]),
  limits: Schema.object({
    maxDurationMs: integer(300_000),
    maxInputBytes: integer(1_048_576),
    maxOutputBytes: integer(262_144),
    maxArtifactBytes: integer(1_048_576),
    maxFiles: integer(128),
    workspaceMiB: integer(1024),
    workspaceInodes: integer(65_536),
    memoryMiB: integer(4096),
    pidsLimit: integer(512),
    cpus: Schema.number().min(0.1).max(8),
  }),
  storage: Schema.object({
    maxStateBytes: integer(16 * 1024 * 1024 * 1024),
    maxJobRecords: integer(1_000_000),
    resultRetentionMs: Schema.number().step(1).min(0).max(365 * 24 * 60 * 60 * 1000),
  }),
  maxConcurrentJobs: integer(16).default(2),
  maxReservedMemoryMiB: integer(65_536).default(2048),
  maxReservedWorkspaceInodes: integer(1_048_576).default(32_768),
})

export type ValidatedConfig = {
  backend: IsolationBackend
  configuredBackend: IsolationBackendConfig
  linux?: { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }
  macos?: MacosIsolationConfig
  windows?: WindowsIsolationConfig
  stateRoot: string
  grants: IsolationGrant[]
  limits: IsolationLimits
  storage: IsolationStoragePolicy
  maxConcurrentJobs: number
  maxReservedMemoryMiB: number
  maxReservedWorkspaceInodes: number
}

export interface ValidateConfigOptions {
  platform?: NodeJS.Platform
  uid?: number
  allowHostPaths?: boolean
}

function defaultStateRoot(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return process.platform === 'win32'
      ? win32.join(homedir(), '.dsh', 'assistant-isolation')
      : 'C:\\Users\\dsh\\.dsh\\assistant-isolation'
  }
  return posix.join(homedir(), '.dsh', 'assistant-isolation')
}

function validateMacosConfig(value: unknown, stateRoot: string): MacosIsolationConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assistant-isolation: invalid macOS configuration')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'runtime' && key !== 'readOnlyRoots' && key !== 'sandboxExecPath')) {
    throw new Error('assistant-isolation: invalid macOS configuration')
  }
  let runtime: NativeMacRuntime | undefined
  if (record.runtime !== undefined) {
    runtime = validateNativeMacRuntime(record.runtime)
    if (runtime.roots.some(root => isPathWithinOrEqual(stateRoot, root.path, 'darwin') || isPathWithinOrEqual(root.path, stateRoot, 'darwin'))) {
      throw new Error('assistant-isolation: state overlaps macOS runtime')
    }
  }
  let readOnlyRoots: string[] | undefined
  if (record.readOnlyRoots !== undefined) {
    if (!Array.isArray(record.readOnlyRoots) || record.readOnlyRoots.length > 32) {
      throw new Error('assistant-isolation: invalid macOS read-only roots')
    }
    const home = homedir()
    readOnlyRoots = record.readOnlyRoots.map(entry => {
      if (!canonicalAbsolutePath(entry, 'darwin')) {
        throw new Error('assistant-isolation: canonical macOS read-only root required')
      }
      if (entry === '/' || entry === '/Users' || entry === '/private' || entry === '/System' || entry === '/usr'
        || entry === home || isPathWithinOrEqual(home, entry, 'darwin')
        || isPathWithinOrEqual(stateRoot, entry, 'darwin') || isPathWithinOrEqual(entry, stateRoot, 'darwin')) {
        throw new Error('assistant-isolation: overbroad macOS read-only root')
      }
      return entry
    })
  }
  let sandboxExecPath: string | undefined
  if (record.sandboxExecPath !== undefined) {
    if (!canonicalAbsolutePath(record.sandboxExecPath, 'darwin')) {
      throw new Error('assistant-isolation: canonical macOS sandbox-exec path required')
    }
    sandboxExecPath = record.sandboxExecPath
  }
  return {
    ...(runtime !== undefined ? { runtime } : {}),
    ...(readOnlyRoots !== undefined ? { readOnlyRoots } : {}),
    ...(sandboxExecPath !== undefined ? { sandboxExecPath } : {}),
  }
}

function validateWindowsConfig(value: unknown): WindowsIsolationConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assistant-isolation: invalid Windows configuration')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'powershellPath' && key !== 'shell' && key !== 'shellPath')) {
    throw new Error('assistant-isolation: invalid Windows configuration')
  }
  let powershellPath: string | undefined
  if (record.powershellPath !== undefined) {
    if (!canonicalAbsolutePath(record.powershellPath, 'win32')) {
      throw new Error('assistant-isolation: canonical Windows powershellPath required')
    }
    powershellPath = record.powershellPath
  }
  let shell: 'cmd' | 'powershell' | undefined
  if (record.shell !== undefined) {
    if (record.shell !== 'cmd' && record.shell !== 'powershell') {
      throw new Error('assistant-isolation: invalid Windows shell')
    }
    shell = record.shell
  }
  let shellPath: string | undefined
  if (record.shellPath !== undefined) {
    if (!canonicalAbsolutePath(record.shellPath, 'win32')) {
      throw new Error('assistant-isolation: canonical Windows shellPath required')
    }
    shellPath = record.shellPath
  }
  return {
    ...(powershellPath !== undefined ? { powershellPath } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(shellPath !== undefined ? { shellPath } : {}),
  }
}

export function validateConfig(input: Config, options: ValidateConfigOptions = {}): ValidatedConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('assistant-isolation: configuration object required')
  }
  input = configShape(input)
  const platform = options.platform ?? process.platform
  const uid = options.uid ?? process.getuid?.()
  const configuredBackend: IsolationBackendConfig = input.backend ?? 'auto'
  const backend = resolveIsolationBackend(configuredBackend, platform)
  const targetPlatform: NodeJS.Platform = backend === 'windows-job' ? 'win32' : backend === 'macos-seatbelt' ? 'darwin' : 'linux'
  const pathPlatform: NodeJS.Platform = options.allowHostPaths ? process.platform : targetPlatform
  const stateRoot = input.stateRoot ?? defaultStateRoot(pathPlatform)
  const grants = structuredClone(input.grants ?? [])

  if (!canonicalAbsolutePath(stateRoot, pathPlatform) || stateRoot.includes(',')) {
    throw new Error('assistant-isolation: canonical absolute state root required')
  }
  if (pathPlatform !== 'win32' && stateRoot.includes('\\')) {
    throw new Error('assistant-isolation: canonical absolute state root required')
  }

  const limits = { ...defaultLimits, ...input.limits }
  const storage = validateStoragePolicy({ ...defaultStoragePolicy, ...input.storage })
  const maxima: IsolationLimits = {
    maxDurationMs: 300_000,
    maxInputBytes: 1_048_576,
    maxOutputBytes: 262_144,
    maxArtifactBytes: 1_048_576,
    maxFiles: 128,
    memoryMiB: 4096,
    workspaceMiB: 1024,
    workspaceInodes: 65_536,
    pidsLimit: 512,
    cpus: 8,
  }
  for (const key of Object.keys(limits) as Array<keyof IsolationLimits>) {
    if (!(key in maxima) || !Number.isFinite(limits[key]) || limits[key] <= 0 || limits[key] > maxima[key]
      || (key !== 'cpus' && !Number.isSafeInteger(limits[key])) || (key === 'cpus' && limits[key] < 0.1)) {
      throw new Error('assistant-isolation: invalid limits')
    }
  }
  const maxConcurrentJobs = input.maxConcurrentJobs ?? 2
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 16) {
    throw new Error('assistant-isolation: invalid concurrency')
  }

  let linux: { runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots } | undefined
  let macos: MacosIsolationConfig | undefined
  let windows: WindowsIsolationConfig | undefined
  let requiredMemory = limits.memoryMiB + limits.workspaceMiB + 32
  let requiredInodes = limits.workspaceInodes
  let requiredStorage = 3 * plannedStorageBytes(limits)

  if (backend === 'linux-native') {
    if (platform !== 'linux' || !uid || stateRoot.includes('\\') || !input.linux
      || Object.keys(input.linux).sort().join() !== 'cgroupRoots,runtime') {
      throw new Error('assistant-isolation: Linux native runtime and cgroup roots required')
    }
    const runtime = validateLinuxRuntime(input.linux.runtime)
    if (runtime.root.path === stateRoot || runtime.root.path.startsWith(stateRoot + sep)
      || stateRoot.startsWith(runtime.root.path + sep)) {
      throw new Error('assistant-isolation: state overlaps Linux runtime')
    }
    const contract = validateLinuxExecutionContract({
      schemaVersion: 1,
      backend,
      runtimeDigest: linuxRuntimeDigest(runtime),
      profile: 'ordinary',
      limits,
      keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 },
      cgroupRoots: input.linux.cgroupRoots,
    })
    if (Object.entries(contract.cgroupRoots).some(([key, value]) => key !== 'mode' && !value.endsWith(`/uid-${uid}`))) {
      throw new Error('assistant-isolation: Linux native requires current-user cgroup v1 or v2 roots')
    }
    linux = { runtime, cgroupRoots: contract.cgroupRoots }
    const reservation = linuxJobResourceReservation(contract)
    requiredMemory = reservation.memoryMiB
    requiredInodes = reservation.workspaceInodes
    requiredStorage = reservation.storageBytes
  } else if (backend === 'macos-seatbelt') {
    if (platform !== 'darwin' || !uid) {
      throw new Error('assistant-isolation: macos-seatbelt backend requires non-root macOS')
    }
    macos = validateMacosConfig(input.macos, stateRoot)
  } else {
    if (platform !== 'win32') {
      throw new Error('assistant-isolation: windows-job backend requires Windows')
    }
    windows = validateWindowsConfig(input.windows)
  }

  const maxReservedMemoryMiB = input.maxReservedMemoryMiB ?? 2048
  const maxReservedWorkspaceInodes = input.maxReservedWorkspaceInodes ?? 32_768
  if (!Number.isSafeInteger(maxReservedMemoryMiB) || maxReservedMemoryMiB < requiredMemory || maxReservedMemoryMiB > 65_536
    || !Number.isSafeInteger(maxReservedWorkspaceInodes) || maxReservedWorkspaceInodes < requiredInodes || maxReservedWorkspaceInodes > 1_048_576) {
    throw new Error('assistant-isolation: invalid resource pool')
  }
  for (const grant of grants) {
    if (!canonicalAbsolutePath(grant.workspace, pathPlatform) || !/^[0-9a-f]{64}$/.test(grant.principalDigest)) {
      throw new Error('assistant-isolation: invalid grant scope')
    }
  }
  if (storage.maxStateBytes < requiredStorage) {
    throw new Error('assistant-isolation: storage budget below planned job allocation')
  }
  return {
    backend,
    configuredBackend,
    ...(linux ? { linux } : {}),
    ...(macos ? { macos } : {}),
    ...(windows ? { windows } : {}),
    stateRoot,
    grants,
    limits,
    storage,
    maxConcurrentJobs,
    maxReservedMemoryMiB,
    maxReservedWorkspaceInodes,
  }
}

/** Loader and direct callers share the same synchronous admission checks. */
export const Config: Schema<Config> = Schema.transform(Schema.any(), (value, options) => {
  try { return validateConfig(value) }
  catch (error) { throw new Schema.ValidationError(String(error), options ?? { path: [] }) }
}) as Schema<Config>
