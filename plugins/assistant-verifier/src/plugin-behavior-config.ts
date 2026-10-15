import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type { IsolatedVerifierRunnerConfig, NativeMacRuntime,
  NativeMacVerifierRunnerConfig } from '@dsh-enhanced/assistant-isolation'

export const NATIVE_BEHAVIOR_BOUNDARY = 'macos-seatbelt-single-process-v1'
export type PluginBehaviorRunnerConfig = Omit<IsolatedVerifierRunnerConfig, 'command'>
  | Omit<NativeMacVerifierRunnerConfig, 'source'>
export type PluginBehaviorDeploymentConfig = Omit<IsolatedVerifierRunnerConfig, 'command' | 'authorityDigest'>
  | Omit<NativeMacVerifierRunnerConfig, 'source' | 'authorityDigest'>

function exactKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
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
  const native = !!value && typeof value === 'object'
    && Object.getOwnPropertyDescriptor(value, 'backend')?.value === 'macos-seatbelt'
  if (!exactKeys(value, [...common, ...(native ? ['backend', 'runtime'] : ['image', 'dockerPath'])], native ? [] : ['socketPath'])
    || !absolute(value.stateRoot) || typeof value.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.authorityDigest)
    || !positive(value.expiresAt, 8_640_000_000_000_000) || !positive(value.maxRuns, 10_000)
    || !positive(value.maxTotalDurationMs, 86_400_000) || !positive(value.maxDurationMs, 300_000)
    || Number(value.maxDurationMs) > Number(value.maxTotalDurationMs)
    || !positive(value.maxOutputBytes, 262_144) || Number(value.maxOutputBytes) < 65_536) {
    throw new Error('invalid plugin behavior runner config')
  }
  if (native) nativeRuntime(value.runtime)
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
    || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item))
    throw new Error('invalid plugin behavior deployment config')
  const checked = validatePluginBehaviorRunnerConfig({ ...value, authorityDigest: '0'.repeat(64) })
  const { authorityDigest: _authorityDigest, ...deployment } = checked
  return deployment as PluginBehaviorDeploymentConfig
}
