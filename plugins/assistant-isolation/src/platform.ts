export type IsolationBackend = 'linux-native' | 'macos-seatbelt' | 'windows-job'
export type IsolationBackendConfig = 'auto' | IsolationBackend

const BACKENDS: ReadonlySet<string> = new Set(['linux-native', 'macos-seatbelt', 'windows-job'])

export function isSupportedIsolationBackend(value: unknown): value is IsolationBackend {
  return typeof value === 'string' && BACKENDS.has(value)
}

export function isSupportedIsolationBackendConfig(value: unknown): value is IsolationBackendConfig {
  return value === 'auto' || isSupportedIsolationBackend(value)
}

export function resolveIsolationBackend(
  backend: IsolationBackendConfig = 'auto',
  platform: NodeJS.Platform = process.platform,
): IsolationBackend {
  if (backend === 'auto') {
    if (platform === 'linux') return 'linux-native'
    if (platform === 'darwin') return 'macos-seatbelt'
    if (platform === 'win32') return 'windows-job'
    throw new Error(`assistant-isolation: unsupported platform ${platform}`)
  }
  if (isSupportedIsolationBackend(backend)) return backend
  throw new Error(`assistant-isolation: unsupported isolation backend ${String(backend)}`)
}
