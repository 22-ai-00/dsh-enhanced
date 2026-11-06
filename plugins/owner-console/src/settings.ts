/** Minimal structural seam for the Host settings service; no package dependency. */
export interface SettingsSecret { readonly path: readonly string[], readonly set: boolean }
export interface SettingsDescriptor {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
  readonly user?: unknown
  readonly applies: 'live'
  readonly secrets?: readonly SettingsSecret[]
}
export type SettingsPathOp =
  | Readonly<{ op: 'set', path: readonly string[], value: unknown }>
  | Readonly<{ op: 'unset', path: readonly string[] }>

export interface SettingsService {
  describe(options?: Readonly<{ redactSecrets?: boolean }>): readonly SettingsDescriptor[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/u
export const APP_ID = /^cli_[0-9a-fA-F]{16}$/u
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u
export const MAX_CONFIG_BYTES = 16_384

export const isEntryId = (value: unknown): value is string => typeof value === 'string' && ENTRY.test(value)
export const isAppId = (value: unknown): value is string => typeof value === 'string' && APP_ID.test(value)
export const isEnvName = (value: unknown): value is string => typeof value === 'string' && ENV_NAME.test(value)
export const isSecretRef = (value: unknown): value is string => typeof value === 'string' && SECRET_REF.test(value)

export interface BundleInfoLike {
  readonly name: string
  readonly version?: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly removable: boolean
  readonly optional: boolean
  /** `error.code === 'not-bundle'` marks a dependency row without a bundle patch. */
  readonly error?: Readonly<{ code?: string }>
}
export interface PluginInfoLike {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}
/** A package the running DSH version refused; the Host reports the exact peer requirements it missed. */
export interface IncompatiblePluginLike {
  readonly name: string
  readonly version: string
  readonly runtimeVersion: string
  readonly requirements: Readonly<Record<string, string>>
}
/** What the Host's pnpm run reported; `kind: 'build-blocked'` is pnpm's dependency-script policy. */
export interface PackageResultLike {
  readonly exitCode?: number
  readonly output?: string
  readonly truncated?: boolean
  readonly logPath?: string
  readonly kind?: string
  readonly timedOut?: boolean
  readonly incompatible?: readonly IncompatiblePluginLike[]
}
export interface ChangeResultLike {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly target: string
  readonly enabled?: boolean
  readonly error?: Readonly<{ code: string, diagnostic?: string, incompatible?: readonly IncompatiblePluginLike[] }>
  readonly warnings?: readonly string[]
  /** Exact `allowBuilds` keys the Host recorded after a failed run; only these may be approved on retry. */
  readonly pendingBuilds?: readonly string[]
  readonly approvedBuilds?: readonly string[]
  readonly packageResult?: PackageResultLike
  readonly failedAt?: 'registry' | 'spec-host'
  readonly restartReason?: string
}
export interface InstallBundleOptions {
  readonly enabled?: boolean
  readonly saveExact?: boolean
  /** Names from a previous result's `pendingBuilds`; the Host refuses any name it no longer holds pending. */
  readonly approvedBuilds?: readonly string[]
}
export interface PluginManagerService {
  listBundles(): Promise<readonly BundleInfoLike[]>
  listPlugins(): Promise<readonly PluginInfoLike[]>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResultLike>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<ChangeResultLike>
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResultLike>
  removeBundle(name: string): Promise<ChangeResultLike>
}

export const PROJECT_PACKAGE = /^@dsh-enhanced\/[a-z0-9][a-z0-9-]*$/u
export const isProjectPackage = (value: unknown): value is string => typeof value === 'string' && PROJECT_PACKAGE.test(value)

export interface LoaderEntry {
  readonly id: string
  readonly options: { readonly id: string, readonly name?: string, readonly config?: unknown, readonly disabled?: boolean | null }
  readonly fiber?: { update(config: unknown, noSave?: boolean): void }
  refresh(): Promise<void>
}
export interface LoaderService { entries(): Iterable<LoaderEntry> }

export function findEntry(descriptors: readonly SettingsDescriptor[], match: (ns: string) => boolean): SettingsDescriptor | undefined {
  return descriptors.find(entry => match(entry.ns))
}

export const isProjectBundle = (ns: string): boolean => ns.startsWith('dsh-enhanced-')

/** Projects are owner-facing facts; never expose redacted secret values. */
export function configFacts(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key === 'secretSource' || !/secret/iu.test(key)))
    : {}
}

export function boundedConfig(input: unknown): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('config must be a JSON object')
  const serialized = JSON.stringify(input)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) throw new Error('config is too large')
  return input as Record<string, unknown>
}
