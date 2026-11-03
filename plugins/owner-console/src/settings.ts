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

export interface LoaderEntry {
  readonly id: string
  readonly options: { readonly id: string, readonly config?: unknown }
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
