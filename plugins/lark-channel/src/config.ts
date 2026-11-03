import Schema from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  account: string
  tenant: string
  appId: string
  appSecretEnv?: string
  credentialHandle?: string
  /** Explicit secret-reference selector so a two-mode switch never leaves both refs active. */
  secretSource?: 'env' | 'handle'
  credentialPurpose?: string
  credentialLeaseMs?: number
  domain?: 'feishu' | 'lark'
  requireMentionInGroups?: boolean
  showProgress?: boolean
  progressDetails?: 'off' | 'direct'
  statusReactions?: boolean
  maxTextBytes?: number
  staleAfterMs?: number
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  imageDownloadTimeoutMs?: number
  userQuestionTtlMs?: number
  /** Exact Calendar IDs that this connector may read; empty means no Calendar API access. */
  allowedCalendarIds?: string[]
}

const schema = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  account: Schema.string().min(1).pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/).required().volatile(),
  tenant: Schema.string().min(1).pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/).required().volatile(),
  appId: Schema.string().pattern(/^cli_[0-9a-fA-F]{16}$/).required().volatile(),
  appSecretEnv: Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/).volatile(),
  credentialHandle: Schema.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/).volatile(),
  secretSource: Schema.union(['env', 'handle'] as const).volatile(),
  credentialPurpose: Schema.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/).default('connect'),
  credentialLeaseMs: Schema.number().step(1).min(1_000).max(86_400_000).default(86_400_000),
  domain: Schema.union(['feishu', 'lark'] as const).default('feishu'),
  requireMentionInGroups: Schema.boolean().default(true),
  showProgress: Schema.boolean().default(true),
  progressDetails: Schema.union(['off', 'direct'] as const).default('direct'),
  statusReactions: Schema.boolean().default(true),
  maxTextBytes: Schema.number().step(1).min(1).max(1024 * 1024).default(65_536),
  staleAfterMs: Schema.number().step(1).min(1_000).max(86_400_000).default(300_000),
  handshakeTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(15_000),
  requestTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(30_000),
  imageDownloadTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(30_000),
  userQuestionTtlMs: Schema.number().step(1).min(60_000).max(7 * 24 * 60 * 60 * 1_000)
    .default(24 * 60 * 60 * 1_000),
  allowedCalendarIds: Schema.array(Schema.string().min(1).max(512)).default([]),
}) as unknown as Schema<Config>

const fields = new Set([
  'account',
  'allowedCalendarIds',
  'appId',
  'appSecretEnv',
  'credentialHandle',
  'credentialLeaseMs',
  'credentialPurpose',
  'domain',
  'enabled',
  'handshakeTimeoutMs',
  'requestTimeoutMs',
  'imageDownloadTimeoutMs',
  'maxTextBytes',
  'progressDetails',
  'requireMentionInGroups',
  'showProgress',
  'staleAfterMs',
  'secretSource',
  'statusReactions',
  'tenant',
  'userQuestionTtlMs',
])

function maskReferences(config: Config): Config {
  if (config.secretSource === 'env') delete config.credentialHandle
  else if (config.secretSource === 'handle') delete config.appSecretEnv
  return config
}

/** Volatile schema fields validate as stable references; this plugin consumes plain values. */
function unwrap(value: unknown): unknown {
  const getter = value !== null && typeof value === 'object' ? (value as { get?: unknown }).get : undefined
  return typeof getter === 'function' ? (value as { get(): unknown }).get() : value
}

function plain(parsed: Config): Config {
  const record = parsed as unknown as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, unwrap(value)])) as unknown as Config
}

const standard = (schema as unknown as { '~standard': Record<string, unknown> })['~standard']
const maskedStandard = {
  ...standard,
  validate: (value: unknown) => {
    const result = (standard['validate'] as (input: unknown) => unknown)(value) as
      { issues?: unknown, value?: unknown }
    if (result.issues !== undefined || result.value === undefined) return result
    return { ...result, value: maskReferences(plain(result.value as Config)) }
  },
}

export const Config = new Proxy(schema, {
  get(target, property, receiver) {
    if (property === '~standard') return maskedStandard
    return Reflect.get(target, property, receiver)
  },
  apply(target, thisArg, argumentsList: [unknown]) {
    // A live settings update hands back stable references for volatile fields;
    // accept both those references and plain values.
    const raw = argumentsList[0]
    const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, unwrap(value)]))
      : raw
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const unknown = Object.keys(input).find(field => !fields.has(field))
      if (unknown !== undefined) throw new Error(`lark-channel: unknown configuration field: ${unknown}`)
    }
    const parsed = plain(Reflect.apply(target, thisArg, [input]) as Config)
    // The bundle row ships a default credentialHandle, so a plain unset of the
    // inherited value is not possible. An explicit selector masks the other
    // reference before the single-reference invariant is checked.
    maskReferences(parsed)
    if (parsed.appSecretEnv !== undefined && parsed.credentialHandle !== undefined) {
      throw new Error('lark-channel: configure credentialHandle or appSecretEnv, not both')
    }
    if (parsed.enabled && parsed.appSecretEnv === undefined && parsed.credentialHandle === undefined) {
      throw new Error('lark-channel: enabled channel requires credentialHandle or appSecretEnv')
    }
    if (new Set(parsed.allowedCalendarIds ?? []).size !== (parsed.allowedCalendarIds ?? []).length
      || (parsed.allowedCalendarIds ?? []).some(value => value.trim() !== value || /[\p{Cc}]/u.test(value))) {
      throw new Error('lark-channel: allowedCalendarIds must be unique stable Calendar IDs')
    }
    return parsed
  },
}) as unknown as Schema<Config>
