import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type { IsolatedVerifierRunnerConfig, NativeMacRuntime,
  NativeMacVerifierRunnerConfig, LinuxVerifierRunnerConfig } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from './linux-behavior-runtime.js'

export const NATIVE_BEHAVIOR_BOUNDARY = 'macos-seatbelt-single-process-v1'
export const LINUX_BEHAVIOR_BOUNDARY = 'linux-native-process-seccomp-v1'
export interface LinuxPluginBehaviorRunnerConfig extends Omit<LinuxVerifierRunnerConfig, 'command' | 'runtime' | 'limits'> {
  runtime: LinuxPluginBehaviorRuntime
}
export type PluginBehaviorRunnerConfig = Omit<IsolatedVerifierRunnerConfig, 'command'>
  | Omit<NativeMacVerifierRunnerConfig, 'source'>
  | LinuxPluginBehaviorRunnerConfig
export type PluginBehaviorDeploymentConfig = Omit<IsolatedVerifierRunnerConfig, 'command' | 'authorityDigest'>
  | Omit<NativeMacVerifierRunnerConfig, 'source' | 'authorityDigest'>

function exactKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
}
function plainData(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return typeof value === 'string' || typeof value === 'number'
  return Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item && plainData(item.value))
}
function linuxCgroups(value: unknown): void {
  if (!exactKeys(value, ['mode', 'cpu', 'memory', 'pids', 'freezer']) || value.mode !== 'v1')
    throw new Error('invalid plugin behavior Linux cgroup roots')
  const roots = [value.cpu, value.memory, value.pids, value.freezer]
  if (new Set(roots).size !== roots.length || roots.some(root => !absolute(root)
    || !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+\/dsh-native\/uid-[1-9][0-9]*$/u.test(root)))
    throw new Error('invalid plugin behavior Linux cgroup roots')
}
// Keep deployment validation pure and independent of Isolation's runtime import.
// The private runner additionally checks the descriptor with the runtime module.
function linuxRuntime(value: unknown): void {
  const hex = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)
  if (!plainData(value) || !exactKeys(value, ['schemaVersion', 'runtime', 'observer']) || value.schemaVersion !== 1
    || !exactKeys(value.observer, ['schemaVersion', 'sourceSha256', 'workerSha256', 'candidateSha256', 'launcherSha256', 'parentProtectSha256', 'childProtectSha256'])
    || value.observer.schemaVersion !== 1
    || Object.entries(value.observer).some(([key, item]) => key !== 'schemaVersion' && !hex(item))
    || !exactKeys(value.runtime, ['schemaVersion', 'backend', 'platform', 'sourceCommit', 'lockSha256', 'root', 'nodePath', 'nodeSha256',
      'pnpmPath', 'nativePnpmPath', 'nativePnpmRoot', 'modulesPath', 'storePath', 'cachePath', 'versions']))
    throw new Error('invalid plugin behavior Linux runtime')
  const runtime = value.runtime
  if (runtime.schemaVersion !== 1 || runtime.backend !== 'linux-native' || runtime.platform !== `linux-${process.arch}`
    || typeof runtime.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(runtime.sourceCommit) || runtime.sourceCommit === '0'.repeat(40)
    || !hex(runtime.lockSha256) || !hex(runtime.nodeSha256)
    || !exactKeys(runtime.root, ['path', 'dev', 'ino', 'sha256']) || !absolute(runtime.root.path) || runtime.root.path === '/'
    || /[\p{Cc}\\]/u.test(runtime.root.path) || !Number.isSafeInteger(runtime.root.dev) || Number(runtime.root.dev) < 0
    || !Number.isSafeInteger(runtime.root.ino) || Number(runtime.root.ino) < 0 || !hex(runtime.root.sha256)
    || !exactKeys(runtime.versions, ['node', 'pnpm', 'typescript', 'cordis', 'tools', 'systemPrompt'])
    || runtime.versions.node !== 'v22.23.2' || runtime.versions.pnpm !== '11.7.0'
    || Object.values(runtime.versions).some(version => typeof version !== 'string' || version.length < 1 || version.length > 128))
    throw new Error('invalid plugin behavior Linux runtime')
  const root = runtime.root.path
  for (const [key, suffix] of Object.entries({ nodePath: '/bin/node', pnpmPath: '/pnpm/bin/pnpm.mjs',
    nativePnpmPath: '/pnpm-native/pnpm', nativePnpmRoot: '/pnpm-native', modulesPath: '/node_modules', storePath: '/store', cachePath: '/cache' })) {
    if (runtime[key] !== root + suffix) throw new Error('invalid plugin behavior Linux runtime')
  }
}
function positive(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max }
function absolute(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0')
}
function nativeRuntime(value: unknown): asserts value is NativeMacRuntime {
  if (!exactKeys(value, ['schemaVersion','platform','nodePath','nodeSha256','roots','modulesPath','versions'])
    || value.schemaVersion !== 1 || value.platform !== `darwin-${process.arch}`
    || !absolute(value.nodePath) || !absolute(value.modulesPath)
    || typeof value.nodeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.nodeSha256)
    || !Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 32
    || !exactKeys(value.versions, ['node','typescript','cordis','tools','systemPrompt'])
    || Object.values(value.versions).some(version => typeof version !== 'string' || version.length < 1 || version.length > 128)) {
    throw new Error('invalid native plugin behavior runtime')
  }
  const roots = value.roots as unknown[]
  if (roots.some(root => !exactKeys(root, ['path','dev','ino','sha256']) || !absolute(root.path)
    || root.path === '/' || !Number.isSafeInteger(root.dev) || Number(root.dev) < 0
    || !Number.isSafeInteger(root.ino) || Number(root.ino) < 0
    || typeof root.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(root.sha256))
    || new Set(roots.map(root => (root as { path: string }).path)).size !== roots.length
    || !roots.some(root => (value.nodePath as string).startsWith((root as { path: string }).path + sep))
    || !roots.some(root => value.modulesPath === (root as { path: string }).path
      || (value.modulesPath as string).startsWith((root as { path: string }).path + sep))) {
    throw new Error('invalid native plugin behavior runtime')
  }
}

export function behaviorNativeRuntimeDigest(runtime: NativeMacRuntime): string {
  nativeRuntime(runtime)
  return createHash('sha256').update(JSON.stringify(runtime)).digest('hex')
}

/** Synchronous shape validation; the native runner rehashes approved runtime bytes before each dispatch. */
export function validatePluginBehaviorRunnerConfig(value: unknown): PluginBehaviorRunnerConfig {
  const common = ['stateRoot', 'authorityDigest', 'expiresAt', 'maxRuns', 'maxTotalDurationMs', 'maxDurationMs', 'maxOutputBytes']
  const backend = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'backend')?.value : undefined
  const native = backend === 'macos-seatbelt', linux = backend === 'linux-native'
  const fields = linux ? ['backend', 'runtime', 'cgroupRoots'] : native ? ['backend', 'runtime'] : ['image', 'dockerPath']
  if (!exactKeys(value, [...common, ...fields], native || linux ? [] : ['socketPath'])
    || !absolute(value.stateRoot) || typeof value.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.authorityDigest)
    || !positive(value.expiresAt, 8_640_000_000_000_000) || !positive(value.maxRuns, 10_000)
    || !positive(value.maxTotalDurationMs, 86_400_000) || !positive(value.maxDurationMs, 300_000)
    || Number(value.maxDurationMs) > Number(value.maxTotalDurationMs)
    || !positive(value.maxOutputBytes, 262_144) || Number(value.maxOutputBytes) < 65_536) {
    throw new Error('invalid plugin behavior runner config')
  }
  if (linux) {
    if (value.stateRoot === '/' || /[\p{Cc}\\]/u.test(value.stateRoot))
      throw new Error('invalid plugin behavior Linux config')
    linuxRuntime(value.runtime)
    linuxCgroups(value.cgroupRoots)
  } else if (native) nativeRuntime(value.runtime)
  else if (typeof value.image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.image)
    || !absolute(value.dockerPath) || Object.hasOwn(value, 'socketPath')
      && (!absolute(value.socketPath) || /[\p{Cc},]/u.test(value.socketPath) || value.socketPath.includes('://'))) {
    throw new Error('invalid plugin behavior Docker config')
  }
  return structuredClone(value) as PluginBehaviorRunnerConfig
}

/** Deployment values omit the digest, which the authenticated owner binds at construction. */
export function validatePluginBehaviorDeploymentConfig(value: unknown): PluginBehaviorDeploymentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.hasOwn(value, 'authorityDigest')
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.getOwnPropertyDescriptor(value, 'backend')?.value === 'linux-native'
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item))
    throw new Error('invalid plugin behavior deployment config')
  const checked = validatePluginBehaviorRunnerConfig({ ...value, authorityDigest: '0'.repeat(64) })
  const { authorityDigest: _authorityDigest, ...deployment } = checked
  return deployment as PluginBehaviorDeploymentConfig
}
